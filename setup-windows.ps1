$ErrorActionPreference = "Stop"

Write-Host "[1/5] 检查 Python 3.14.6..." -ForegroundColor Cyan
if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  throw "未找到 Python Launcher。请先从 python.org 安装 Python 3.14.6，并勾选 Add Python to PATH。"
}
python --version

Write-Host "[2/5] 创建项目虚拟环境 .venv..." -ForegroundColor Cyan
if (-not (Test-Path ".venv\Scripts\python.exe")) {
  python -m venv .venv
}
$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

Write-Host "[3/5] 安装 Python 依赖..." -ForegroundColor Cyan
& $python -m pip install --upgrade pip
& $python -m pip install -r requirements-dev.txt

Write-Host "[4/5] 检查 Node 和 pnpm..." -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "未找到 Node.js。请先安装 Node 24 LTS，然后重新运行本脚本。"
}
node --version
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  npm install --global pnpm@10.12.1
}
pnpm --version
pnpm install

Write-Host "[5/5] 准备环境变量文件..." -ForegroundColor Cyan
if (-not (Test-Path ".env.local")) {
  Copy-Item "env.example" ".env.local"
  Write-Warning "已创建 .env.local，请在里面配置至少一个模型 API Key。"
}

Write-Host "依赖安装完成。现在执行 pnpm dev 启动项目。" -ForegroundColor Green
