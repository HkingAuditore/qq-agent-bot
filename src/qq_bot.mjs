/**
 * QQ Agent Bot — Pure Relay Mode
 *
 * Architecture:
 *   QQ Messages → NapCat (OneBot v11 WS) → This Bot
 *     → Intent Classification (LLM)
 *       → Low priority: Quick Reply (lightweight LLM, direct response)
 *       → High priority: OpenClaw Agent (via Gateway WS RPC)
 *         → Agent processes → writes reply file → Bot polls & sends back
 *
 * Features:
 *   - Multi-worker pool with tier-based agent dispatch
 *   - Intent classification for smart routing
 *   - Quick reply for simple messages, full Agent for complex ones
 *   - Per-chat context injection (markdown-based rolling history)
 *   - Silent group message logging for feedback mining
 *   - Safety filter against prompt injection
 *   - Owner-only admin commands (/model, /route, /stop, etc.)
 *   - HTTP callback server for Agent reply delivery
 *   - File-based reply polling as fallback
 *   - Automatic reconnection for both NapCat and Gateway
 */

import WebSocket from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { mkdir, readFile, writeFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import net from 'net';

import {
  BOT_QQ, OWNER_QQ, OWNER_NAME, BOT_NAME,
  NAPCAT_WS_URL, GATEWAY_HOST, GATEWAY_PORT, GATEWAY_TOKEN,
  CALLBACK_PORT, RECONNECT_DELAY, AGENT_TIMEOUT, PROGRESS_HINT_DELAY,
  PROTOCOL_VERSION, OPENCLAW_SESSION_KEY,
  MONITORED_GROUPS, GROUP_NAMES,
  DATA_DIR, CONTEXT_DIR, GROUP_MSG_LOG_DIR, INTERACTION_LOG_DIR, SHARED_REPLY_DIR,
  CONTEXT_MAX_ENTRIES, CONTEXT_INJECT_COUNT, CONTEXT_EXPIRE_MS, CONTEXT_MAX_TEXT_LEN,
  MODEL_PRESETS, OC_CFG,
  INTENT_API_URL, INTENT_API_KEY, INTENT_MODEL, INTENT_PRESETS,
  QUICK_REPLY_PRESETS, INJECTION_PATTERNS, RATE_LIMIT_WINDOW, RATE_LIMIT_MAX,
  AGENT_PROFILES, WORKER_COUNT,
  getSystemPrompt, getIdentityReminder,
} from '../config/bot.config.mjs';


// ============================================================
// Logging
// ============================================================

function log(level, ...args) {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[${ts}] [${level}]`, ...args);
}

function getBeijingTime() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}


// ============================================================
// Global Error Handlers
// ============================================================

process.on('uncaughtException', (err) => {
  log('FATAL', `Uncaught Exception: ${err.message}`);
  log('FATAL', err.stack);
});
process.on('unhandledRejection', (reason) => {
  log('FATAL', `Unhandled Rejection: ${reason}`);
  if (reason instanceof Error) log('FATAL', reason.stack);
});
process.on('exit', (code) => {
  log('FATAL', `Process exiting with code ${code}`);
});


// ============================================================
// Model Switcher
// ============================================================

function getModel() {
  try { return JSON.parse(readFileSync(OC_CFG, 'utf8')).agents.defaults.model.primary; }
  catch { return 'unknown'; }
}

function setModel(k) {
  const m = MODEL_PRESETS[k]; if (!m) return null;
  try {
    const d = JSON.parse(readFileSync(OC_CFG, 'utf8'));
    d.agents.defaults.model.primary = m.p + '/' + m.id;
    writeFileSync(OC_CFG, JSON.stringify(d, null, 2));
    return m;
  } catch { return null; }
}


// ============================================================
// Intent Classifier
// ============================================================

let currentIntentUrl = INTENT_API_URL;
let currentIntentKey = INTENT_API_KEY;
let currentIntentModel = INTENT_MODEL;

function getIntentModel() { return currentIntentModel; }

function setIntentModel(k) {
  const m = INTENT_PRESETS[k]; if (!m) return null;
  currentIntentUrl = m.url;
  currentIntentKey = m.key;
  currentIntentModel = m.model;
  return m;
}

async function classifyIntent(text) {
  const SYSTEM_PROMPT = `你是一个意图分类与重要性评估器。

第一步：判断用户消息是否属于以下范畴之一：
1. 与群聊主题相关的客服、问答、讨论
2. 与机器人的日常闲聊、问候、娱乐互动
3. 上下文跟进性问句

如果不属于以上范畴，输出 REJECT。

第二步：如果属于以上范畴，评估任务重要性：
- 4：需要深度分析、代码调试、复杂策略推演、多步骤推理
- 3：复杂分析、多步骤推理、需要翻阅大量资料
- 2：中等复杂度问答、BUG报告、需要对比分析
- 1：简单问题、基础疑问、简短事实性回答、简单查询
- 0：简单问候、闲聊、表情互动、简短回应

只输出以下六个词之一：REJECT、0、1、2、3、4`;

  try {
    const res = await fetch(currentIntentUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentIntentKey}`,
      },
      body: JSON.stringify({
        model: currentIntentModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const json = await res.json();
    const raw = (json?.choices?.[0]?.message?.content || '').trim().toUpperCase();
    const verdict = raw === 'REJECT' ? 'REJECT' : ['0', '1', '2', '3', '4'].includes(raw) ? parseInt(raw) : 2;
    log('INFO', `[Intent] "${text.slice(0, 40)}" → ${verdict}`);
    return verdict;
  } catch (err) {
    log('WARN', `[Intent] classifier error, defaulting 3: ${err.message}`);
    return 3;
  }
}


// ============================================================
// Quick Reply — lightweight LLM for LOW priority messages
// ============================================================

let QUICK_MODEL_KEY = '1';
let routeMode = 'auto';  // 'auto' | 'all-agent' | 'all-quick'

const TOMATO_PROMPT = getSystemPrompt();

async function quickReply(text, userId, nickname) {
  const preset = QUICK_REPLY_PRESETS[QUICK_MODEL_KEY];
  const res = await fetch(preset.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${preset.key}` },
    body: JSON.stringify({
      model: preset.model,
      messages: [
        { role: 'system', content: `${TOMATO_PROMPT}\n\n当前北京时间：${getBeijingTime()}` },
        { role: 'user', content: `来自用户 ${nickname || '未知'}(QQ:${userId || '未知'})的消息：${text}` },
      ],
      max_tokens: 300,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Quick API ${res.status}`);
  const json = await res.json();
  return (json?.choices?.[0]?.message?.content || '').trim() || `${BOT_NAME}暂时想不出来～`;
}


// ============================================================
// Safety Filter
// ============================================================

const userRateMap = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  if (!userRateMap.has(userId)) { userRateMap.set(userId, [now]); return true; }
  const ts = userRateMap.get(userId).filter(t => now - t < RATE_LIMIT_WINDOW);
  ts.push(now); userRateMap.set(userId, ts);
  return ts.length <= RATE_LIMIT_MAX;
}

function checkInjection(text) {
  return INJECTION_PATTERNS.some(p => p.test(text));
}


// ============================================================
// Silent Group Message Logger
// ============================================================

async function ensureDir(dir) {
  try { await mkdir(dir, { recursive: true }); } catch {}
}

async function writeGroupLog(groupId, userId, nickname, text, atList) {
  await ensureDir(GROUP_MSG_LOG_DIR);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const logFile = path.join(GROUP_MSG_LOG_DIR, `group_${groupId}_${dateStr}.jsonl`);
  const entry = JSON.stringify({
    time_cst: timeStr,
    user_id: String(userId),
    nickname,
    text,
    at_list: atList || [],
    is_owner: String(userId) === OWNER_QQ,
  });
  await writeFile(logFile, entry + '\n', { flag: 'a' });
}


// ============================================================
// Interaction Logger
// ============================================================

async function recordInteraction(question, reply, sourceType, sourceId, nickname, agentLabel, durationMs) {
  await ensureDir(INTERACTION_LOG_DIR);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const tsCst = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const entry = JSON.stringify({
    ts: tsCst, nickname, question: question.slice(0, 300),
    reply: reply.slice(0, 500), agent: agentLabel,
    duration_ms: durationMs, source: `${sourceType}:${sourceId}`,
  });
  const logFile = path.join(INTERACTION_LOG_DIR, `interactions_${dateStr}.jsonl`);
  await writeFile(logFile, entry + '\n', { flag: 'a' });
}


// ============================================================
// Chat Context Manager — per-chat markdown history
// ============================================================

function getChatId(targetType, targetId) {
  return `${targetType}_${targetId}`;
}

function getContextFilePath(chatId) {
  return path.join(CONTEXT_DIR, `context_${chatId}.md`);
}

function getSessionKeyForChat(agentId, targetType, targetId) {
  const chatScope = targetType === 'group' ? `qq-group-${targetId}` : `qq-private-${targetId}`;
  return `agent:${agentId}:${chatScope}`;
}

async function appendContext(chatId, role, nickname, text, workerLabel) {
  await ensureDir(CONTEXT_DIR);
  const filePath = getContextFilePath(chatId);
  const now = new Date();
  const ts = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const truncated = String(text).slice(0, CONTEXT_MAX_TEXT_LEN);
  const roleTag = role === 'user' ? `**用户(${nickname})**` : `**Bot[${workerLabel || 'Unknown'}]**`;
  const entry = `### ${ts}\n${roleTag}: ${truncated}\n`;

  let existing = '';
  try { existing = await readFile(filePath, 'utf8'); } catch {}
  existing += entry;
  const entries = existing.split(/(?=^### )/m).filter(s => s.startsWith('### '));
  if (entries.length > CONTEXT_MAX_ENTRIES) {
    const header = `<!-- chatId: ${chatId} -->\n`;
    const trimmed = entries.slice(entries.length - CONTEXT_MAX_ENTRIES).join('');
    await writeFile(filePath, header + trimmed);
  } else {
    await writeFile(filePath, existing);
  }
}

async function readRecentContext(chatId, maxEntries = CONTEXT_INJECT_COUNT) {
  try {
    const filePath = getContextFilePath(chatId);
    const content = await readFile(filePath, 'utf8');
    const entries = content.split(/(?=^### )/m).filter(s => s.startsWith('### '));
    const recent = entries.slice(-maxEntries);
    if (!recent.length) return '';
    const lines = recent.map(entry => {
      const match = entry.match(/^### (.+?)\n\*\*(.+?)\*\*: (.+)/s);
      if (!match) return null;
      const [, ts, role, msg] = match;
      const timeMatch = ts.match(/(\d{1,2}:\d{2})/g);
      const timeStr = timeMatch ? timeMatch[timeMatch.length - 1] : ts.slice(-5);
      return `[${timeStr}] ${role}: ${msg.trim().slice(0, 120)}`;
    }).filter(Boolean);
    return lines.length ? `【近期上下文】\n${lines.join('\n')}\n\n` : '';
  } catch { return ''; }
}

async function cleanupAllContexts() {
  try {
    const files = await readdir(CONTEXT_DIR);
    const mdFiles = files.filter(f => f.startsWith('context_') && f.endsWith('.md'));
    const now = Date.now();
    for (const file of mdFiles) {
      const filePath = path.join(CONTEXT_DIR, file);
      try {
        const content = await readFile(filePath, 'utf8');
        const entries = content.split(/(?=^### )/m).filter(s => s.startsWith('### '));
        if (!entries.length) continue;
        const lastEntry = entries[entries.length - 1];
        const tsMatch = lastEntry.match(/^### (.+)/);
        if (tsMatch) {
          const lastTs = new Date(tsMatch[1]).getTime();
          if (now - lastTs > CONTEXT_EXPIRE_MS) {
            await writeFile(filePath, '');
            log('DEBUG', `[Context] Expired: ${file}`);
          }
        }
      } catch {}
    }
  } catch {}
}


// ============================================================
// Worker Pool — multi-agent dispatch
// ============================================================

const WORKERS = Array.from({ length: WORKER_COUNT }, (_, i) => ({
  id: `worker-${i}`,
  state: 'idle',
  currentAgent: null,
  currentTask: null,
}));

function findIdleWorker() {
  return WORKERS.find(w => w.state === 'idle');
}

function acquireWorker(worker, agentProfile, userId, requestId, question) {
  worker.state = 'busy';
  worker.currentAgent = agentProfile;
  worker.currentTask = { userId, requestId, startTime: Date.now(), question: question.slice(0, 60) };
  log('INFO', `[Worker] Acquired ${worker.id} -> Agent[${agentProfile.label}] for user=${userId} req=${requestId}`);
}

function releaseWorker(worker) {
  const label = worker.currentAgent?.label || '?';
  const req = worker.currentTask?.requestId || '?';
  worker.state = 'idle';
  worker.currentAgent = null;
  worker.currentTask = null;
  log('INFO', `[Worker] Released ${worker.id} (was: Agent[${label}] req=${req})`);
}

function cancelWorkerPending(worker, reason) {
  if (worker.currentTask?.requestId) {
    const pr = pendingRequests.get(worker.currentTask.requestId);
    if (pr) {
      clearTimeout(pr.timer);
      pendingRequests.delete(worker.currentTask.requestId);
      stopReplyFilePoller(worker.currentTask.requestId);
      pr.reject(new Error(reason));
    }
  }
}

function selectAgent(intentLevel) {
  for (const profile of AGENT_PROFILES) {
    if (intentLevel >= profile.minIntent) return profile;
  }
  return AGENT_PROFILES[AGENT_PROFILES.length - 1];
}

function getWorkerByUser(userId) {
  return WORKERS.find(w => w.state === 'busy' && w.currentTask?.userId === String(userId));
}

function getWorkerStatus() {
  return WORKERS.map(w => {
    if (w.state === 'idle') return `${w.id}: 🟢 idle`;
    const dur = w.currentTask ? ((Date.now() - w.currentTask.startTime) / 1000).toFixed(0) + 's' : '?';
    return `${w.id}: 🔴 ${w.currentAgent?.label || '?'} (${dur}) Q="${w.currentTask?.question || '?'}"`;
  }).join('\n');
}


// ============================================================
// Pending Request Management
// ============================================================

const pendingRequests = new Map();
const activeAgentRequests = new Map();
const replyFilePollers = new Map();

function registerPendingRequest(requestId, targetType, targetId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      stopReplyFilePoller(requestId);
      reject(new Error('Agent response timeout'));
    }, AGENT_TIMEOUT);
    pendingRequests.set(requestId, { resolve, reject, timer, targetType, targetId });
    startReplyFilePoller(requestId);
  });
}

function resolvePendingRequest(requestId, message) {
  const pr = pendingRequests.get(requestId);
  if (!pr) return false;
  clearTimeout(pr.timer);
  pendingRequests.delete(requestId);
  stopReplyFilePoller(requestId);
  pr.resolve(message);
  return true;
}

// File-based reply polling (fallback for HTTP callback)
function startReplyFilePoller(requestId) {
  const replyFile = path.join(SHARED_REPLY_DIR, `qq_reply_${requestId}.txt`);
  const interval = setInterval(async () => {
    try {
      const content = await readFile(replyFile, 'utf8');
      if (content.trim()) {
        resolvePendingRequest(requestId, content.trim());
        try { await writeFile(replyFile, ''); } catch {} // clear after read
      }
    } catch {} // file doesn't exist yet
  }, 1500);
  replyFilePollers.set(requestId, interval);
}

function stopReplyFilePoller(requestId) {
  const interval = replyFilePollers.get(requestId);
  if (interval) {
    clearInterval(interval);
    replyFilePollers.delete(requestId);
  }
}


// ============================================================
// HTTP Callback Server — receives Agent replies
// ============================================================

function startCallbackServer() {
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405); res.end('Method Not Allowed'); return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);

        if (req.url === '/callback' || req.url === '/reply') {
          const { requestId, message, targetType, targetId } = data;
          let resolved = false;
          if (requestId) {
            resolved = resolvePendingRequest(requestId, String(message));
          }
          if (resolved) {
            log('INFO', `[Callback] Resolved requestId=${requestId}: ${String(message).slice(0, 80)}`);
          } else if (targetType && targetId) {
            sendMsg(targetType, String(targetId), String(message));
            resolved = true;
            log('INFO', `[Callback] Fallback direct send → ${targetType}:${targetId}`);
          } else {
            log('WARN', `[Callback] Unknown requestId=${requestId}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: resolved }));

        } else if (req.url === '/send') {
          const { targetType, targetId, message } = data;
          if (!targetType || !targetId || !message) throw new Error('Missing params');
          sendMsg(targetType, String(targetId), String(message));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));

        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ ok: false, error: 'Unknown endpoint' }));
        }
      } catch (e) {
        log('ERROR', `[Callback] Error: ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('WARN', `Port ${CALLBACK_PORT} in use, retrying in 3s...`);
      setTimeout(() => { server.close(); server.listen(CALLBACK_PORT, '127.0.0.1'); }, 3000);
    } else {
      log('ERROR', `Callback server error: ${err.message}`);
    }
  });

  server.listen(CALLBACK_PORT, '127.0.0.1', () => {
    log('INFO', `✅ Callback server on 127.0.0.1:${CALLBACK_PORT}`);
  });
}


// ============================================================
// OpenClaw Gateway WebSocket (RPC to Agent)
// ============================================================

let gatewayWs = null;
let gatewayWsReady = false;
const gatewayPending = new Map();

function gatewaySendWithId(id, method, params) {
  return new Promise((resolve, reject) => {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('Gateway WS not open'));
    }
    const frame = { type: 'req', id, method, params };
    const timer = setTimeout(() => {
      gatewayPending.delete(id);
      reject(new Error(`Gateway RPC timeout for ${method}`));
    }, 30000);
    gatewayPending.set(id, { resolve, reject, timer });
    gatewayWs.send(JSON.stringify(frame));
    log('DEBUG', `[GW→] ${method} id=${id}`);
  });
}

function gatewaySend(method, params) {
  return new Promise((resolve, reject) => {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('Gateway WS not open'));
    }
    const id = randomUUID();
    const frame = { type: 'req', id, method, params };
    const timer = setTimeout(() => {
      gatewayPending.delete(id);
      reject(new Error(`Gateway RPC timeout for ${method}`));
    }, 30000);
    gatewayPending.set(id, { resolve, reject, timer });
    gatewayWs.send(JSON.stringify(frame));
    log('DEBUG', `[GW→] ${method} id=${id}`);
  });
}

function connectGateway() {
  const url = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`;
  log('INFO', `Connecting to Gateway: ${url}`);
  gatewayWs = new WebSocket(url);
  gatewayWsReady = false;

  gatewayWs.on('open', () => {
    log('INFO', '✅ Gateway WS connected, waiting for challenge...');
  });

  gatewayWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Handle connect challenge
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const { nonce, ts } = msg.payload || {};
        const connectId = randomUUID();
        const connectFrame = {
          type: 'req', id: connectId, method: 'connect',
          params: {
            minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
            client: { name: 'qq-agent-bot', version: '1.0.0' },
            auth: { mode: 'token', token: GATEWAY_TOKEN },
            nonce, ts,
          },
        };
        gatewayWs.send(JSON.stringify(connectFrame));
        return;
      }

      // Handle connect response
      if (msg.type === 'res' && msg.result?.type === 'hello-ok') {
        gatewayWsReady = true;
        log('INFO', '✅ Gateway handshake complete');
        return;
      }

      // Handle RPC responses
      if (msg.type === 'res' && msg.id) {
        const p = gatewayPending.get(msg.id);
        if (p) {
          gatewayPending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
        return;
      }

      // Handle events (agent activity, etc.)
      if (msg.type === 'event') {
        // Could add custom event handling here
        return;
      }

      // Handle errors
      if (msg.type === 'error') {
        const errMsg = msg.error?.message || JSON.stringify(msg);
        log('ERROR', `[GW] Error: ${errMsg}`);
        return;
      }

      log('DEBUG', `[GW] Unknown frame: ${JSON.stringify(msg).slice(0, 120)}`);
    } catch (e) {
      log('ERROR', `[GW] Parse error: ${e.message}`);
    }
  });

  gatewayWs.on('close', (code, reason) => {
    gatewayWsReady = false;
    log('WARN', `[GW] WebSocket closed (code=${code}), reconnecting in 5s...`);
    for (const [id, p] of gatewayPending) {
      clearTimeout(p.timer);
      p.reject(new Error('Gateway connection closed'));
    }
    gatewayPending.clear();
    setTimeout(connectGateway, RECONNECT_DELAY);
  });

  gatewayWs.on('error', (e) => {
    log('ERROR', `[GW] WebSocket error: ${e.message}`);
    gatewayWs.terminate();
  });
}


// ============================================================
// Reset Agent Session
// ============================================================

async function resetSession(sessionKey) {
  if (!gatewayWsReady) throw new Error('Gateway WS not connected');
  const result = await gatewaySend('sessions.reset', { key: sessionKey || OPENCLAW_SESSION_KEY });
  log('INFO', `[Session] Reset OK: key=${result?.key}`);
  return result;
}


// ============================================================
// Send Message to Agent and Wait for Reply
// ============================================================

async function askAgent(targetType, targetId, nickname, text, userId, worker = null) {
  if (!gatewayWsReady) throw new Error('Gateway WS not connected');

  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const source = targetType === 'group' ? `群聊(${targetId})` : `私聊`;

  const agentId = worker?.currentAgent?.agentId || 'main';
  const sessionKey = getSessionKeyForChat(agentId, targetType, targetId);

  const chatId = getChatId(targetType, targetId);
  const recentContext = await readRecentContext(chatId);

  const replyFile = path.join(SHARED_REPLY_DIR, `qq_reply_${requestId}.txt`);
  const identityReminder = getIdentityReminder();

  const agentMessage = `${identityReminder}\n${recentContext}【QQ群消息】

当前北京时间：${getBeijingTime()}

来自 ${source} 的用户 ${nickname}(QQ:${userId})：
${text}

⚠️ 回复方式：用 write 工具将你的回复内容写入文件 ${replyFile}
只需写入文件即可，系统会自动检测并发送给用户。不需要执行任何回调命令。

requestId: ${requestId}`;

  const rpcId = randomUUID();
  activeAgentRequests.set(requestId, { rpcId });

  try {
    await gatewaySendWithId(rpcId, 'agent', {
      message: agentMessage,
      sessionKey,
      idempotencyKey: requestId,
    });
    log('INFO', `[Agent] Dispatched requestId=${requestId}: ${text.slice(0, 60)}`);
  } catch (err) {
    activeAgentRequests.delete(requestId);
    throw new Error(`Agent dispatch failed: ${err.message}`);
  }

  try {
    const reply = await registerPendingRequest(requestId, targetType, targetId);
    return reply;
  } finally {
    activeAgentRequests.delete(requestId);
  }
}


// ============================================================
// NapCat OneBot v11 WebSocket (QQ messages)
// ============================================================

let ws = null;
let reconnectTimer = null;

function sendMsg(targetType, targetId, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log('WARN', 'NapCat WS not connected, cannot send');
    return;
  }
  const action = targetType === 'group' ? 'send_group_msg' : 'send_private_msg';
  const idKey = targetType === 'group' ? 'group_id' : 'user_id';
  const payload = {
    action,
    params: { [idKey]: Number(targetId), message: [{ type: 'text', data: { text: message } }] },
  };
  ws.send(JSON.stringify(payload));
  log('INFO', `↗ [${targetType}→${targetId}]: ${message.slice(0, 80)}`);
}


// ============================================================
// Message Handler
// ============================================================

const userLocks = new Map();
const groupPending = new Map();

function incrementGroupPending(key) {
  groupPending.set(key, (groupPending.get(key) || 0) + 1);
}
function decrementGroupPending(key) {
  const v = (groupPending.get(key) || 1) - 1;
  if (v <= 0) groupPending.delete(key); else groupPending.set(key, v);
}

async function handleMessage(event) {
  const msgType = event.message_type;
  const groupId = event.group_id;
  const userId  = event.user_id;
  const nickname = event.sender?.nickname || String(userId);

  // Extract text from message segments
  let text = '';
  const atList = [];
  if (Array.isArray(event.message)) {
    for (const seg of event.message) {
      if (seg.type === 'text') text += seg.data?.text || '';
      if (seg.type === 'at') atList.push(seg.data?.qq);
    }
  } else {
    text = String(event.raw_message || event.message || '');
  }
  text = text.trim();
  if (!text) return;

  // Silent logging for monitored groups
  if (groupId && MONITORED_GROUPS.has(String(groupId))) {
    writeGroupLog(groupId, userId, nickname, text, atList).catch(() => {});
  }

  // Only respond if @bot or private message
  const isAtBot = atList.includes(String(BOT_QQ));
  if (msgType === 'group' && !isAtBot && !text.startsWith('/')) return;

  // Remove @bot text
  text = text.replace(new RegExp(`@${BOT_QQ}`, 'g'), '').trim();

  const targetType = msgType === 'group' ? 'group' : 'private';
  const targetId   = msgType === 'group' ? groupId : userId;

  log('INFO', `↙ [${msgType}] ${nickname}(${userId})${groupId ? ' 群' + groupId : ''}: ${text}`);

  // ── Record user message to context ──
  const chatId = getChatId(targetType, targetId);
  appendContext(chatId, 'user', nickname, text).catch(() => {});

  // ── Command handling ──
  const cmd = text.toLowerCase().trim();

  if (cmd === '/new') {
    if (String(userId) !== OWNER_QQ) { sendMsg(targetType, targetId, '只有主人才能重置对话哦~'); return; }
    try {
      // Reset all agent sessions for this chat
      for (const profile of AGENT_PROFILES) {
        const sk = getSessionKeyForChat(profile.agentId, targetType, targetId);
        try { await gatewaySend('sessions.reset', { key: sk }); } catch {}
      }
      sendMsg(targetType, targetId, '✅ 已开启新对话，所有 Agent 的聊天记录已清空。');
    } catch (e) {
      sendMsg(targetType, targetId, '重置失败: ' + e.message);
    }
    return;
  }

  if (cmd === '/stop') {
    const w = getWorkerByUser(String(userId));
    if (!w) { sendMsg(targetType, targetId, '你没有正在运行的任务。'); return; }
    cancelWorkerPending(w, 'Interrupted by /stop');
    releaseWorker(w);
    sendMsg(targetType, targetId, `✅ 已中断 ${w.id} Worker 的任务。`);
    return;
  }

  if (cmd === '/status') {
    sendMsg(targetType, targetId, `📊 Bot Status\nModel: ${getModel()}\nRoute: ${routeMode}\nIntent: ${currentIntentModel}\n\n${getWorkerStatus()}`);
    return;
  }

  if (cmd === '/model') {
    sendMsg(targetType, targetId, '当前模型: ' + getModel());
    return;
  }
  if (cmd === '/model list') {
    let ls = '可用模型:\n';
    const cur = getModel();
    for (const [k, v] of Object.entries(MODEL_PRESETS)) {
      const mk = cur === v.p + '/' + v.id ? ' ← 当前' : '';
      ls += `/model ${k} — ${v.n}${mk}\n`;
    }
    sendMsg(targetType, targetId, ls.trim());
    return;
  }
  if (cmd.startsWith('/model ')) {
    if (String(userId) !== OWNER_QQ) { sendMsg(targetType, targetId, '只有管理员可以切换模型'); return; }
    const m = setModel(cmd.split(' ')[1]);
    if (!m) { sendMsg(targetType, targetId, '无效编号，用 /model list 查看'); return; }
    sendMsg(targetType, targetId, '✅ 模型已切换到: ' + m.n);
    return;
  }

  if (cmd === '/route') {
    sendMsg(targetType, targetId, `路由模式: ${routeMode}\n\n${getWorkerStatus()}`);
    return;
  }
  if (cmd.startsWith('/route ')) {
    if (String(userId) !== OWNER_QQ) { sendMsg(targetType, targetId, '只有管理员可以切换'); return; }
    const m = cmd.split(' ')[1];
    routeMode = m === 'agent' ? 'all-agent' : m === 'quick' ? 'all-quick' : 'auto';
    sendMsg(targetType, targetId, '✅ 路由模式: ' + routeMode);
    return;
  }

  if (cmd === '/help') {
    sendMsg(targetType, targetId,
      `🤖 ${BOT_NAME} 命令列表\n` +
      `/new — 重置对话\n` +
      `/stop — 中断当前任务\n` +
      `/status — 查看状态\n` +
      `/model — 查看/切换模型\n` +
      `/route — 查看/切换路由模式\n` +
      `/help — 显示此帮助`
    );
    return;
  }

  // ── Safety checks ──
  if (String(userId) !== OWNER_QQ) {
    if (!checkRateLimit(String(userId))) {
      sendMsg(targetType, targetId, '你发消息太快了，请稍等一下～');
      return;
    }
    if (checkInjection(text)) {
      sendMsg(targetType, targetId, '检测到不安全的指令，已拒绝处理。');
      log('WARN', `[Safety] Injection blocked from ${nickname}(${userId}): ${text.slice(0, 60)}`);
      return;
    }
  }

  // ── Lock & intent classification ──
  const lockKey = `${targetType}:${targetId}:${userId}`;
  const groupKey = `${targetType}:${targetId}`;

  if (userLocks.has(lockKey)) {
    sendMsg(targetType, targetId, '上一个问题还在处理中，请稍候～');
    return;
  }
  userLocks.set(lockKey, true);
  incrementGroupPending(groupKey);

  const intentLevel = await classifyIntent(text);
  if (intentLevel === 'REJECT') {
    userLocks.delete(lockKey); decrementGroupPending(groupKey);
    return; // silently ignore irrelevant messages
  }

  // ── Route: Quick Reply vs Agent ──
  const useAgent = routeMode === 'all-agent' || (routeMode === 'auto' && intentLevel >= 1);
  log('INFO', `[Route] ${useAgent ? 'Agent' : 'Quick'}(${intentLevel}) mode=${routeMode}: ${text.slice(0, 40)}`);

  if (!useAgent) {
    try {
      const reply = await quickReply(text, userId, nickname);
      sendMsg(targetType, targetId, reply);
      recordInteraction(text, reply, targetType, targetId, nickname, 'Quick', 0).catch(() => {});
    } catch (err) {
      log('WARN', `[QuickReply] failed: ${err.message}, fallback Agent`);
      sendMsg(targetType, targetId, '正在思考中，请稍候...');
      try {
        const r = await askAgent(targetType, targetId, nickname, text, userId);
        sendMsg(targetType, targetId, r);
      } catch (e2) {
        sendMsg(targetType, targetId, '抱歉，AI暂时无法响应。');
      }
    }
    userLocks.delete(lockKey); decrementGroupPending(groupKey);
    return;
  }

  // ── Worker dispatch ──
  const agentProfile = selectAgent(intentLevel);
  const worker = findIdleWorker();
  if (!worker) {
    log('WARN', `[Worker] All workers busy, rejecting ${nickname}(${userId})`);
    sendMsg(targetType, targetId, '⏳ 所有 AI 助手都在忙，请稍后再试～');
    userLocks.delete(lockKey); decrementGroupPending(groupKey);
    return;
  }

  acquireWorker(worker, agentProfile, String(userId), `req-${Date.now()}`, text);
  sendMsg(targetType, targetId, `正在思考中(${worker.id}->${agentProfile.label})，请稍候...`);

  const progressTimers = [];
  progressTimers.push(setTimeout(() => {
    if (userLocks.has(lockKey)) sendMsg(targetType, targetId, '⏳ 正在深度思考中，还需一点时间...');
  }, 25000));
  progressTimers.push(setTimeout(() => {
    if (userLocks.has(lockKey)) sendMsg(targetType, targetId, '仍在处理中，请耐心等待...');
  }, 60000));

  try {
    const reply = await askAgent(targetType, targetId, nickname, text, userId, worker);
    sendMsg(targetType, targetId, reply);
    const _dur = worker.currentTask ? Date.now() - worker.currentTask.startTime : 0;
    recordInteraction(text, reply, targetType, targetId, nickname, agentProfile.label, _dur).catch(() => {});
  } catch (err) {
    log('ERROR', `Handler error [${worker.id}]:`, err.message);
    if (err.message.includes('timeout')) {
      sendMsg(targetType, targetId, '抱歉，AI 处理超时了，请稍后再试。');
    } else {
      sendMsg(targetType, targetId, '抱歉，AI 暂时无法响应，请稍后再试。');
    }
  } finally {
    progressTimers.forEach(t => clearTimeout(t));
    releaseWorker(worker);
    userLocks.delete(lockKey);
    decrementGroupPending(groupKey);
  }
}


// ============================================================
// NapCat Event Handler
// ============================================================

function handleEvent(raw) {
  try {
    const event = JSON.parse(raw);
    if (event.post_type === 'message') {
      handleMessage(event).catch(e => log('ERROR', `handleMessage error: ${e.message}`));
    }
  } catch (e) {
    log('ERROR', `Event parse error: ${e.message}`);
  }
}

function connect() {
  log('INFO', `Connecting to NapCat: ${NAPCAT_WS_URL}`);
  ws = new WebSocket(NAPCAT_WS_URL);

  ws.on('open', () => {
    log('INFO', '✅ NapCat connected');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  });
  ws.on('message', data => handleEvent(data.toString()));
  ws.on('close', (code) => {
    log('WARN', `NapCat WS closed (${code}), reconnecting...`);
    if (!reconnectTimer) reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  });
  ws.on('error', err => {
    log('ERROR', 'NapCat WS error:', err.message);
    ws.terminate();
  });
}


// ============================================================
// Startup
// ============================================================

const keepAliveTimer = setInterval(() => {
  const gwStatus = gatewayWsReady ? 'ready' : 'not ready';
  const napcatStatus = ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
  log('DEBUG', `[Health] Gateway=${gwStatus}, NapCat=${napcatStatus}, pending=${pendingRequests.size}`);

  if (!gatewayWs || gatewayWs.readyState === WebSocket.CLOSED) {
    log('WARN', '[Health] Gateway WS is closed, reconnecting...');
    connectGateway();
  }
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    log('WARN', '[Health] NapCat WS is closed, reconnecting...');
    connect();
  }
}, 30000);

log('INFO', `🤖 ${BOT_NAME} (QQ Agent Bot) starting...`);
startCallbackServer();
connectGateway();
connect();

setInterval(cleanupAllContexts, 60 * 60 * 1000);
ensureDir(CONTEXT_DIR).then(() => log('INFO', '✅ Chat context directory ready'));
ensureDir(GROUP_MSG_LOG_DIR).then(() => log('INFO', '✅ Group message log directory ready'));
ensureDir(INTERACTION_LOG_DIR).then(() => log('INFO', '✅ Interaction log directory ready'));
