#!/usr/bin/env bash
# ============================================================================
# WG Voice Agent Playground — macOS / Linux 一键启动脚本 (Java 17 + SIP/RTP 网关)
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8091}"

echo "============================================================"
echo "  WG Voice Agent Playground (v0.5) — macOS / Linux Launcher"
echo "  Author: 王果 (wangguode)"
echo "============================================================"

cd "$SCRIPT_DIR/java-freeswitch-rtp-bridge"

if [ ! -f "target/freeswitch-rtp-bridge-0.3.0.jar" ]; then
  echo "[1/2] 正在编译打包 Java 17 语音网关内核..."
  mvn -B -q clean package -DskipTests
fi

echo "[2/2] 正在启动 WG Voice Agent Playground: http://127.0.0.1:${PORT}"
if command -v open >/dev/null 2>&1; then
  (sleep 2 && open "http://127.0.0.1:${PORT}") &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 2 && xdg-open "http://127.0.0.1:${PORT}") &
fi

exec java -jar target/freeswitch-rtp-bridge-0.3.0.jar --server.port="${PORT}"
