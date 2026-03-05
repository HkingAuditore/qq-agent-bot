#!/bin/bash
# ============================================================
# Setup cron jobs for feedback monitor and learning summarizer
# Run this script once after deployment
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Setting up cron jobs for QQ Agent Bot..."
echo "Project directory: $PROJECT_DIR"

# Load .env file
if [ -f "$PROJECT_DIR/.env" ]; then
  export $(grep -v '^#' "$PROJECT_DIR/.env" | xargs)
fi

# Create cron entries
CRON_ENTRIES=$(cat << EOF
# QQ Agent Bot — Feedback Monitor
# Scan every 2 hours
0 */2 * * * cd $PROJECT_DIR && python3 scripts/feedback_monitor.py --scan-only >> /tmp/feedback_monitor.log 2>&1
# Send digest at 12:00 and 21:00
0 12,21 * * * cd $PROJECT_DIR && python3 scripts/feedback_monitor.py >> /tmp/feedback_monitor.log 2>&1
# Daily learning summarizer at 23:30
30 23 * * * cd $PROJECT_DIR && python3 scripts/learning_summarizer.py >> /tmp/learning_summarizer.log 2>&1
EOF
)

# Check if cron entries already exist
if crontab -l 2>/dev/null | grep -q "feedback_monitor.py"; then
  echo "⚠️  Cron entries already exist. Skipping to avoid duplicates."
  echo "   To reset, run: crontab -e"
else
  # Append to existing crontab
  (crontab -l 2>/dev/null; echo "$CRON_ENTRIES") | crontab -
  echo "✅ Cron jobs installed successfully!"
fi

echo ""
echo "Current cron entries:"
crontab -l 2>/dev/null | grep -A1 "Agent Bot"
