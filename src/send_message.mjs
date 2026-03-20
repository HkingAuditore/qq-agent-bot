#!/usr/bin/env node
/**
 * Helper script to send QQ messages via the bot's HTTP callback server
 * 
 * Usage:
 *   node send_message.mjs <targetType> <targetId> <message>
 * 
 * Examples:
 *   node send_message.mjs private 178854663 "Hello!"
 *   node send_message.mjs group 123456789 "群消息测试"
 */

import http from 'http';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '../.env') });

const CALLBACK_HOST = process.env.CALLBACK_HOST || '127.0.0.1';
const CALLBACK_PORT = parseInt(process.env.CALLBACK_PORT || '19283');
const [targetType, targetId, message] = process.argv.slice(2);

if (!targetType || !targetId || !message) {
  console.error('Usage: node send_message.mjs <targetType> <targetId> <message>');
  console.error('  targetType: "private" or "group"');
  console.error('  targetId: QQ number or group ID');
  console.error('  message: message content');
  process.exit(1);
}

const data = JSON.stringify({ targetType, targetId: Number(targetId), message });

const req = http.request({
  hostname: CALLBACK_HOST,
  port: CALLBACK_PORT,
  path: '/send',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    let payload = null;
    try { payload = body ? JSON.parse(body) : null; } catch { payload = null; }
    if (res.statusCode === 200 && payload?.ok) {
      console.log('✅ Message sent successfully');
      return;
    }
    const errorMsg = payload?.error || body || 'Unknown error';
    console.error(`❌ Failed (${res.statusCode}): ${errorMsg}`);
    process.exit(1);
  });
});

req.on('error', (e) => { console.error(`❌ Error: ${e.message}`); process.exit(1); });
req.write(data);
req.end();
