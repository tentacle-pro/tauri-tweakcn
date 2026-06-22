#!/bin/bash
# 启动前检查
if [ -z "$GEMINI_API_KEY" ]; then
    echo "⚠️  GEMINI_API_KEY 未设置！WS 中继不会启动。"
    echo "   export GEMINI_API_KEY=\"your-key-here\""
fi
bun run tauri dev
