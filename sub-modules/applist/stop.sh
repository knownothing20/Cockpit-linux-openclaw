#!/bin/bash
# AppList 停止脚本

cd "$(dirname "$0")"

PID_FILE=".applist.pid"
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if ps -p "$OLD_PID" > /dev/null 2>&1; then
    kill "$OLD_PID"
    echo "[applist] 服务已停止 (PID: $OLD_PID)"
  else
    echo "[applist] 服务未在运行"
  fi
  rm -f "$PID_FILE"
else
  echo "[applist] 服务未在运行"
fi
