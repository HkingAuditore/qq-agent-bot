#!/usr/bin/env python3
"""Daily Learning Summarizer

Analyzes group chat logs, bot conversation history, and feedback records
to extract learning insights and update MEMORY.md.

Usage:
  python3 learning_summarizer.py              # Full pipeline: summarize + update memory
  python3 learning_summarizer.py --summarize  # Only generate summary

Environment variables:
  LLM_URL, LLM_KEY, LLM_MODEL, DATA_DIR, WORKSPACE_DIR
"""

import json, os, sys, glob, re
from datetime import datetime, timezone, timedelta
from urllib.request import urlopen, Request

CST = timezone(timedelta(hours=8))

# ============================================================
# Configuration
# ============================================================

DATA_DIR = os.environ.get('DATA_DIR', '/home/openclaw/.openclaw')
WORKSPACE_DIR = os.environ.get('WORKSPACE_DIR', os.path.join(DATA_DIR, 'workspace'))
LEARNINGS_DIR = os.path.join(WORKSPACE_DIR, 'learnings')
MEMORY_FILE = os.path.join(WORKSPACE_DIR, 'MEMORY.md')
GROUP_LOG_DIR = os.path.join(DATA_DIR, 'group_msg_logs')
FEEDBACK_DIR = os.path.join(DATA_DIR, 'feedback_records')
INTERACTION_LOG_DIR = os.path.join(DATA_DIR, 'interaction_logs')

LLM_URL = os.environ.get('LLM_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
LLM_KEY = os.environ.get('LLM_KEY', '')
LLM_MODEL = os.environ.get('LLM_MODEL', 'qwen-plus')

os.makedirs(LEARNINGS_DIR, exist_ok=True)
os.makedirs(INTERACTION_LOG_DIR, exist_ok=True)


def now_cst():
    return datetime.now(CST)

def today_str():
    return now_cst().strftime('%Y-%m-%d')


def llm_call(prompt, max_tokens=3000, temperature=0.3):
    """Call LLM and return text response."""
    body = json.dumps({
        'model': LLM_MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'max_tokens': max_tokens,
        'temperature': temperature,
    }).encode()
    req = Request(LLM_URL, data=body, headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {LLM_KEY}',
    })
    resp = urlopen(req, timeout=60)
    result = json.loads(resp.read())
    return result['choices'][0]['message']['content'].strip()


# ============================================================
# Load Today's Data
# ============================================================

def load_interactions(date_str):
    """Load today's bot interactions."""
    log_file = os.path.join(INTERACTION_LOG_DIR, f'interactions_{date_str}.jsonl')
    items = []
    if os.path.exists(log_file):
        with open(log_file) as f:
            for line in f:
                try: items.append(json.loads(line))
                except: pass
    return items

def load_feedback(date_str):
    """Load today's feedback records."""
    fb_file = os.path.join(FEEDBACK_DIR, f'feedback_{date_str}.jsonl')
    items = []
    if os.path.exists(fb_file):
        with open(fb_file) as f:
            for line in f:
                try: items.append(json.loads(line))
                except: pass
    return items


# ============================================================
# Summarize
# ============================================================

def generate_summary():
    """Generate a daily learning summary from interactions and feedback."""
    date_str = today_str()
    interactions = load_interactions(date_str)
    feedback = load_feedback(date_str)

    if not interactions and not feedback:
        print('[INFO] No data to summarize today')
        return None

    # Build context for LLM
    context_parts = []

    if interactions:
        context_parts.append(f'## 今日Bot对话记录 ({len(interactions)}条)')
        for it in interactions[:50]:  # limit to 50
            context_parts.append(f"- Q: {it.get('question', '')[:100]}")
            context_parts.append(f"  A: {it.get('reply', '')[:100]}")
            if it.get('duration_ms', 0) > 30000:
                context_parts.append(f"  ⚠️ 响应较慢: {it['duration_ms']/1000:.1f}s")

    if feedback:
        context_parts.append(f'\n## 今日用户反馈 ({len(feedback)}条)')
        for fb in feedback[:30]:
            context_parts.append(f"- [{fb.get('type')}] {fb.get('summary', fb.get('content', '')[:60])}")

    context = '\n'.join(context_parts)

    prompt = f"""分析以下QQ群聊Bot的今日数据，提取有价值的学习要点：

{context}

请输出以下格式的总结：

## 今日学习要点 ({date_str})

### 常见问题 & 回答质量
- 列出重复出现的问题模式
- 评估回答是否准确有效

### 用户偏好洞察
- 用户喜欢什么样的回复风格？
- 哪些回复得到了好的反馈？

### 知识盲区
- Bot 无法回答或回答不好的领域
- 需要补充的知识

### 改进建议
- 具体可执行的改进方向

保持简洁，每个要点不超过2行。"""

    try:
        summary = llm_call(prompt)
        # Save summary
        summary_file = os.path.join(LEARNINGS_DIR, f'summary_{date_str}.md')
        with open(summary_file, 'w') as f:
            f.write(summary)
        print(f'[INFO] Summary saved to {summary_file}')
        return summary
    except Exception as e:
        print(f'[ERROR] Summary generation failed: {e}')
        return None


# ============================================================
# Update MEMORY.md
# ============================================================

def update_memory(summary):
    """Append learning insights to MEMORY.md."""
    if not summary:
        return

    date_str = today_str()

    # Read existing MEMORY.md
    existing = ''
    if os.path.exists(MEMORY_FILE):
        with open(MEMORY_FILE) as f:
            existing = f.read()

    # Check if today's learning already exists
    if f'## 今日学习要点 ({date_str})' in existing:
        print('[INFO] Today\'s learning already in MEMORY.md, skipping')
        return

    # Extract key insights (not the full summary)
    prompt = f"""从以下学习总结中提取最重要的3-5条经验，以简洁的bullet point格式输出，
每条不超过1行。用于更新Bot的长期记忆。

{summary}

格式：
- 经验1
- 经验2
..."""

    try:
        insights = llm_call(prompt, max_tokens=500)

        # Append to MEMORY.md
        section = f'\n\n## 经验积累 ({date_str})\n{insights}\n'

        # Keep MEMORY.md manageable: only keep last 7 days of experiences
        # (manual entries are preserved)
        with open(MEMORY_FILE, 'a') as f:
            f.write(section)

        print(f'[INFO] MEMORY.md updated with {date_str} insights')
    except Exception as e:
        print(f'[ERROR] Memory update failed: {e}')


# ============================================================
# Main
# ============================================================

if __name__ == '__main__':
    summarize_only = '--summarize' in sys.argv
    summary = generate_summary()
    if not summarize_only and summary:
        update_memory(summary)
