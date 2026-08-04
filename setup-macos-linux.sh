#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' '[1/5] 检查 Python 3.13...'
PYTHON_BIN="${PYTHON_EXECUTABLE:-python3.13}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  printf '%s\n' '未找到 Python 3.13。请先从 python.org 或系统包管理器安装。' >&2
  exit 1
fi
"$PYTHON_BIN" --version

printf '%s\n' '[2/5] 创建项目虚拟环境 .venv...'
if [[ ! -x .venv/bin/python ]]; then
  "$PYTHON_BIN" -m venv .venv
fi

printf '%s\n' '[3/5] 安装 Python 依赖...'
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements-dev.txt

printf '%s\n' '[4/5] 检查 Node 和 pnpm...'
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '未找到 Node.js。请先安装 Node 24 LTS。' >&2
  exit 1
fi
node --version
if ! command -v pnpm >/dev/null 2>&1; then
  npm install --global pnpm@10.12.1
fi
pnpm --version
pnpm install

printf '%s\n' '[5/5] 准备环境变量文件...'
if [[ ! -f .env.local ]]; then
  cp env.example .env.local
  printf '%s\n' '已创建 .env.local，请在里面配置至少一个模型 API Key。'
fi

printf '%s\n' '依赖安装完成。现在执行 pnpm dev 启动项目。'
