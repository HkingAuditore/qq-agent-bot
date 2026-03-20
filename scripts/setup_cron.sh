#!/bin/bash
# ============================================================
# Setup cron jobs for feedback monitor and learning summarizer
# Run this script once after deployment
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Setting up cron jobs for QQ Agent Bot..."
echo "Project directory: $PROJECT_DIR"

MARKER_BEGIN="# BEGIN QQ Agent Bot"
MARKER_END="# END QQ Agent Bot"

CRON_ENTRIES=$(cat <<EOF
$MARKER_BEGIN
# QQ Agent Bot — Feedback Monitor
# Scan every 2 hours
0 */2 * * * python3 "$PROJECT_DIR/scripts/run_with_env.py" "$PROJECT_DIR" python3 scripts/feedback_monitor.py --scan-only >> /tmp/feedback_monitor.log 2>&1
# Send digest at 12:00 and 21:00
0 12,21 * * * python3 "$PROJECT_DIR/scripts/run_with_env.py" "$PROJECT_DIR" python3 scripts/feedback_monitor.py >> /tmp/feedback_monitor.log 2>&1
# Daily learning summarizer at 23:30
30 23 * * * python3 "$PROJECT_DIR/scripts/run_with_env.py" "$PROJECT_DIR" python3 scripts/learning_summarizer.py >> /tmp/learning_summarizer.log 2>&1
$MARKER_END
EOF
)

CURRENT_CRONTAB=$(crontab -l 2>/dev/null || true)
CLEAN_CRONTAB=$(printf '%s\n' "$CURRENT_CRONTAB" | python3 -c 'import sys
lines = sys.stdin.read().splitlines()
out = []
skip = False
for line in lines:
    if line.strip() == "# BEGIN QQ Agent Bot":
        skip = True
        continue
    if line.strip() == "# END QQ Agent Bot":
        skip = False
        continue
    if not skip:
        out.append(line)
print("\n".join(out).strip())')

if [ -n "$CLEAN_CRONTAB" ]; then
  {
    printf '%s\n' "$CLEAN_CRONTAB"
    printf '\n%s\n' "$CRON_ENTRIES"
  } | crontab -
else
  printf '%s\n' "$CRON_ENTRIES" | crontab -
fi

echo "✅ Cron jobs installed/updated successfully!"
echo ""
echo "Current cron entries:"
crontab -l 2>/dev/null | grep -A4 "QQ Agent Bot"
