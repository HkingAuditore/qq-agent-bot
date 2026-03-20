#!/usr/bin/env python3
"""Group Feedback Monitor

Scans group message logs, classifies feedback/bugs using lightweight LLM,
stores structured results, and sends periodic digest to owner via QQ.

Usage:
  python3 feedback_monitor.py              # Full run: scan + digest
  python3 feedback_monitor.py --scan-only  # Only scan, no digest

Environment variables (or edit the config section below):
  LLM_URL, LLM_KEY, LLM_MODEL, OWNER_QQ, BOT_QQ,
  MONITORED_GROUPS (comma-separated), GROUP_NAMES (JSON),
  DATA_DIR, NODE_BIN
"""

import json, os, sys, time, glob
from datetime import datetime, timezone, timedelta
from urllib.request import urlopen, Request
from urllib.error import URLError

CST = timezone(timedelta(hours=8))

# ============================================================
# Configuration — override via environment variables
# ============================================================

DATA_DIR = os.environ.get('DATA_DIR', '/home/openclaw/.openclaw')
LOG_DIR = os.path.join(DATA_DIR, 'group_msg_logs')
FEEDBACK_DIR = os.path.join(DATA_DIR, 'feedback_records')
OWNER_QQ = os.environ.get('OWNER_QQ', '')
BOT_QQ = os.environ.get('BOT_QQ', '')

GROUPS = os.environ.get('MONITORED_GROUPS', '').split(',')
GROUP_NAMES = {}
try:
    GROUP_NAMES = json.loads(os.environ.get('GROUP_NAMES', '{}'))
except:
    pass

NODE_BIN = os.environ.get('NODE_BIN', 'node')

LLM_URL = os.environ.get('LLM_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
LLM_KEY = os.environ.get('LLM_KEY', '')
LLM_MODEL = os.environ.get('LLM_MODEL', 'qwen-plus')

os.makedirs(FEEDBACK_DIR, exist_ok=True)


# ============================================================
# LLM Classification
# ============================================================

def llm_classify(messages_batch, group_id):
    """Classify a batch of messages, return list of feedback items."""
    if not messages_batch:
        return []
    msg_text = '\n'.join([
        f'[{m["time_cst"]}] {m["nickname"]}({m["user_id"]}): {m["text"]}'
        for m in messages_batch
    ])
    group_label = GROUP_NAMES.get(group_id, group_id)
    prompt = f"""你是一个社区消息分析器。以下是QQ群【{group_label}】的聊天记录片段。
请从中识别出与群聊主题相关的：
1. Bug反馈（类型标记为 bug）
2. 功能建议（类型标记为 suggestion）
3. 玩法问题/疑惑（类型标记为 question）
4. 负面体验反馈（类型标记为 complaint）

忽略纯闲聊、无关讨论、表情包、水群等。
如果消息中@了主人({OWNER_QQ})或@了机器人，要特别留意。

返回JSON数组格式（如果没有识别到任何反馈，返回空数组 []）：
[{{"type":"bug/suggestion/question/complaint","user":"昵称","content":"原始消息摘要","summary":"一句话总结","priority":"high/medium/low","at_owner":true/false}}]

只输出JSON数组，不要有其他文字。

--- 聊天记录 ---
{msg_text}
"""
    try:
        body = json.dumps({
            'model': LLM_MODEL,
            'messages': [{'role': 'user', 'content': prompt}],
            'max_tokens': 2000,
            'temperature': 0.2,
        }).encode()
        req = Request(LLM_URL, data=body, headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {LLM_KEY}',
        })
        resp = urlopen(req, timeout=30)
        result = json.loads(resp.read())
        text = result['choices'][0]['message']['content'].strip()
        # Extract JSON from response
        if text.startswith('```'):
            text = text.split('\n', 1)[1].rsplit('```', 1)[0].strip()
        items = json.loads(text)
        for item in items:
            item['group_id'] = group_id
        return items
    except Exception as e:
        print(f'[WARN] LLM classify error: {e}')
        return []


# ============================================================
# Scan & Store
# ============================================================

def scan_group_logs():
    """Scan today's group logs, classify new messages, store results."""
    date_str = datetime.now(CST).strftime('%Y-%m-%d')
    feedback_file = os.path.join(FEEDBACK_DIR, f'feedback_{date_str}.jsonl')

    # Load already-processed message IDs
    processed = set()
    if os.path.exists(feedback_file):
        with open(feedback_file) as f:
            for line in f:
                try:
                    item = json.loads(line)
                    key = f"{item.get('user','')}-{item.get('content','')[:30]}"
                    processed.add(key)
                except:
                    pass

    new_count = 0
    for gid in GROUPS:
        gid = gid.strip()
        if not gid:
            continue
        log_file = os.path.join(LOG_DIR, f'group_{gid}_{date_str}.jsonl')
        if not os.path.exists(log_file):
            continue

        messages = []
        with open(log_file) as f:
            for line in f:
                try:
                    msg = json.loads(line)
                    # Skip bot's own messages
                    if msg.get('user_id') == BOT_QQ:
                        continue
                    messages.append(msg)
                except:
                    pass

        if not messages:
            continue

        # Process in batches of 20
        batch_size = 20
        for i in range(0, len(messages), batch_size):
            batch = messages[i:i + batch_size]
            items = llm_classify(batch, gid)
            for item in items:
                key = f"{item.get('user','')}-{item.get('content','')[:30]}"
                if key in processed:
                    continue
                processed.add(key)
                item['date'] = date_str
                item['scan_time'] = datetime.now(CST).isoformat()
                with open(feedback_file, 'a') as f:
                    f.write(json.dumps(item, ensure_ascii=False) + '\n')
                new_count += 1

    print(f'[INFO] Scanned {date_str}: {new_count} new feedback items')
    return new_count


# ============================================================
# Digest Generation
# ============================================================

def _fmt_section(title, items):
    """Format a section of feedback items."""
    if not items:
        return ''
    r = title + '\n'
    seen = set()
    for i, it in enumerate(items, 1):
        key = (it.get('user', ''), it.get('summary', ''))
        if key in seen:
            continue
        seen.add(key)
        pri = '🔴' if it.get('priority') == 'high' else '🟡' if it.get('priority') == 'medium' else '🟢'
        at = ' 📌@你' if it.get('at_owner') else ''
        r += f'{pri} {i}. [{it.get("user", "?")}] {it.get("summary", it.get("content", "")[:60])}{at}\n'
    return r + '\n'


def generate_digest():
    """Generate and send digest to owner and groups."""
    date_str = datetime.now(CST).strftime('%Y-%m-%d')
    feedback_file = os.path.join(FEEDBACK_DIR, f'feedback_{date_str}.jsonl')
    if not os.path.exists(feedback_file):
        print('[INFO] No feedback file for today')
        return

    items = []
    with open(feedback_file) as f:
        for line in f:
            try:
                items.append(json.loads(line))
            except:
                pass

    if not items:
        print('[INFO] No feedback items')
        return

    # Group by group_id
    by_group = {}
    no_group = []
    for item in items:
        gid = item.get('group_id')
        if gid:
            by_group.setdefault(gid, []).append(item)
        else:
            no_group.append(item)

    parts = []

    for gid, group_items in by_group.items():
        group_name = GROUP_NAMES.get(gid, f'群{gid}')
        bugs = [i for i in group_items if i.get('type') == 'bug']
        suggestions = [i for i in group_items if i.get('type') == 'suggestion']
        questions = [i for i in group_items if i.get('type') == 'question']
        complaints = [i for i in group_items if i.get('type') == 'complaint']
        high_pri = [i for i in group_items if i.get('priority') == 'high']
        at_owner = [i for i in group_items if i.get('at_owner')]

        r = f'📋 【{group_name}】反馈汇总 - {date_str}\n\n'
        r += f'📊 统计: Bug {len(bugs)} | 建议 {len(suggestions)}'
        r += f' | 疑问 {len(questions)} | 吐槽 {len(complaints)}\n'
        if high_pri:
            r += f'⚠️ 高优先级: {len(high_pri)}条\n'
        if at_owner:
            r += f'📌 @你的消息: {len(at_owner)}条\n'
        r += '\n'
        r += _fmt_section('🐛 Bug反馈:', bugs)
        r += _fmt_section('💡 功能建议:', suggestions)
        r += _fmt_section('❓ 疑问:', questions)
        r += _fmt_section('😤 负面反馈:', complaints)

        # Send to this group
        send_qq_msg('group', gid, r.strip())
        parts.append(r.strip())

    # Handle items without group_id (legacy data)
    if no_group:
        bugs = [i for i in no_group if i.get('type') == 'bug']
        suggestions = [i for i in no_group if i.get('type') == 'suggestion']
        questions = [i for i in no_group if i.get('type') == 'question']
        complaints = [i for i in no_group if i.get('type') == 'complaint']
        high_pri = [i for i in no_group if i.get('priority') == 'high']
        at_own = [i for i in no_group if i.get('at_owner')]
        r = f'📋 【未分类(旧数据)】反馈 - {date_str}\n\n'
        r += f'📊 统计: Bug {len(bugs)} | 建议 {len(suggestions)}'
        r += f' | 疑问 {len(questions)} | 吐槽 {len(complaints)}\n'
        if high_pri:
            r += f'⚠️ 高优先级: {len(high_pri)}条\n'
        if at_own:
            r += f'📌 @你的消息: {len(at_own)}条\n'
        r += '\n'
        r += _fmt_section('🐛 Bug反馈:', bugs)
        r += _fmt_section('💡 功能建议:', suggestions)
        r += _fmt_section('❓ 疑问:', questions)
        r += _fmt_section('😤 负面反馈:', complaints)
        parts.append(r.strip())

    # Send combined digest to owner
    if parts and OWNER_QQ:
        combined = '\n\n━━━━━━━━━━━━━━━\n\n'.join(parts)
        send_qq_msg('private', OWNER_QQ, combined)
        print(f'[INFO] Digest sent to owner {OWNER_QQ}')


# ============================================================
# Send QQ Message (via bot's HTTP callback)
# ============================================================

def send_qq_msg(target_type, target_id, message):
    """Send a message via the bot's HTTP /send endpoint."""
    import subprocess
    try:
        # Use the bot's send_message helper
        script_dir = os.path.dirname(os.path.abspath(__file__))
        send_script = os.path.join(script_dir, '..', 'src', 'send_message.mjs')
        if os.path.exists(send_script):
            completed = subprocess.run([NODE_BIN, send_script, target_type, str(target_id), message],
                         timeout=10, capture_output=True, text=True)
            if completed.returncode != 0:
                stderr = (completed.stderr or completed.stdout or '').strip()
                raise RuntimeError(stderr or f'send_message exited with code {completed.returncode}')
        else:
            # Fallback: direct HTTP call
            body = json.dumps({
                'targetType': target_type,
                'targetId': int(target_id),
                'message': message,
            }).encode()
            req = Request('http://127.0.0.1:19283/send', data=body, headers={
                'Content-Type': 'application/json',
            })
            resp = urlopen(req, timeout=10)
            payload = json.loads(resp.read().decode('utf-8') or '{}')
            if getattr(resp, 'status', 200) != 200 or not payload.get('ok'):
                raise RuntimeError(payload.get('error') or f'HTTP {getattr(resp, "status", "?")}')
        print(f'[INFO] Sent to {target_type}:{target_id}')
    except Exception as e:
        print(f'[WARN] Send failed: {e}')


# ============================================================
# Main
# ============================================================

if __name__ == '__main__':
    scan_only = '--scan-only' in sys.argv
    scan_group_logs()
    if not scan_only:
        generate_digest()
