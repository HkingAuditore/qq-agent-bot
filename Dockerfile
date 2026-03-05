# ============================================================
# QQ Agent Bot — Docker Image
#
# This only containers the bot relay layer.
# You still need:
#   1. NapCat running separately (for QQ protocol)
#   2. OpenClaw Agent running separately (for AI processing)
# ============================================================

FROM node:22-slim

WORKDIR /app

# Install Python for feedback scripts
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --production 2>/dev/null || npm install --production

# Copy source code
COPY config/ ./config/
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY persona/ ./persona/

# Create data directories
RUN mkdir -p /data/chat_contexts /data/group_msg_logs /data/feedback_records \
    /data/interaction_logs /data/delivery-queue /data/workspace

# Default environment
ENV DATA_DIR=/data
ENV WORKSPACE_DIR=/data/workspace
ENV NODE_ENV=production

EXPOSE 19283

CMD ["node", "src/qq_bot.mjs"]
