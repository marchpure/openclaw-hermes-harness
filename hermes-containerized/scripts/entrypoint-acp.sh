#!/bin/bash
# ACP + Gateway 双进程 entrypoint
# 先以后台方式启动 Hermes gateway，再启动 ACP TCP bridge
set -e

HERMES_HOME="/opt/data"
INSTALL_DIR="/opt/hermes"

source "${INSTALL_DIR}/.venv/bin/activate"

mkdir -p "$HERMES_HOME"/{cron,sessions,logs,hooks,memories,skills,skins,plans,workspace,home}

if [ ! -f "$HERMES_HOME/.env" ]; then
    cp "$INSTALL_DIR/.env.example" "$HERMES_HOME/.env"
fi

if [ ! -f "$HERMES_HOME/config.yaml" ]; then
    cp "$INSTALL_DIR/cli-config.yaml.example" "$HERMES_HOME/config.yaml"
fi

if [ ! -f "$HERMES_HOME/SOUL.md" ]; then
    cp "$INSTALL_DIR/docker/SOUL.md" "$HERMES_HOME/SOUL.md"
fi

if [ -d "$INSTALL_DIR/skills" ]; then
    python3 "$INSTALL_DIR/tools/skills_sync.py" 2>/dev/null || true
fi

# 后台启动 Hermes gateway (消息平台网关)
hermes gateway run &
GATEWAY_PID=$!
echo "Hermes gateway started (PID: $GATEWAY_PID)"

# 定义清理函数
cleanup() {
    echo "Shutting down..."
    kill $GATEWAY_PID 2>/dev/null || true
    wait $GATEWAY_PID 2>/dev/null || true
    exit 0
}
trap cleanup SIGTERM SIGINT

# 前台启动 ACP TCP bridge (OpenClaw 插件通信)
exec python3 /opt/hermes/acp-tcp-server.py
