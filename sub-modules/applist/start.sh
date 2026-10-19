#!/bin/bash
# AppList 启动脚本

cd "$(dirname "$0")"

# 检查是否已在运行
PID_FILE=".applist.pid"
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if ps -p "$OLD_PID" > /dev/null 2>&1; then
    echo "[applist] 服务已在运行 (PID: $OLD_PID)"
    echo "[applist] 访问 http://127.0.0.1:17149"
    exit 0
  fi
fi

echo "[applist] 启动服务..."
node server.js &
PID=$!
echo $PID > "$PID_FILE"
echo "[applist] 服务已启动 (PID: $PID)"
echo "[applist] 访问 http://127.0.0.1:17149"
