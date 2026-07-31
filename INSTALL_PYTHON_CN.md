# 从零安装 Python 和项目依赖

本文按“第一次接触 Python 后端”的方式编写。推荐使用 **Python 3.13**，避免不同机器上的第三方包兼容差异。

## 一、先检查现有环境

在项目根目录打开终端。

Windows PowerShell：

```powershell
node --version
pnpm --version
py -3.13 --version
```

macOS / Linux：

```bash
node --version
pnpm --version
python3.13 --version
```

任何一条提示“找不到命令”，按下面对应章节安装。

## 二、安装 Python

### Windows

1. 到 Python 官方下载页安装 Python 3.13 的 64 位版本。
2. 安装界面勾选 **Add python.exe to PATH**。
3. 安装后重新打开 PowerShell。
4. 验证：

```powershell
py -3.13 --version
```

如果 `python` 指向 Microsoft Store 或其他版本，不必纠结；后续一直使用 `py -3.13` 即可。

### macOS

可使用 Python 官方安装包，或者你已有的 Homebrew。安装完成后验证：

```bash
python3.13 --version
```

### Linux

使用发行版包管理器安装 Python 3.13、venv 和开发头文件。不同发行版包名不同，安装后确认：

```bash
python3.13 --version
python3.13 -m venv --help
```

## 三、创建虚拟环境

虚拟环境相当于项目专属的 `node_modules`，可以防止多个 Python 项目的依赖互相污染。

### Windows

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
```

看到命令行前面出现 `(.venv)` 表示激活成功。

PowerShell 如果拦截脚本：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

### macOS / Linux

```bash
python3.13 -m venv .venv
source .venv/bin/activate
```

### 不激活也能使用

Windows：

```powershell
.\.venv\Scripts\python.exe --version
```

macOS / Linux：

```bash
./.venv/bin/python --version
```

## 四、安装 Python 依赖

先确认当前 Python 来自 `.venv`：

```bash
python -c "import sys; print(sys.executable)"
```

然后安装：

```bash
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.txt
```

两个 requirements 的区别：

- `requirements.txt`：应用运行必需的 FastAPI、Uvicorn、HTTP 客户端和 Windows 时区数据等；
- `requirements-dev.txt`：在运行依赖基础上，增加 PyInstaller 和测试工具。

验证：

```bash
python -c "import fastapi, uvicorn, httpx, tzdata; print('Python 依赖正常')"
python -m pytest backend/tests -q
```

## 五、安装 Node 和 pnpm

你原来是前端项目，仍然需要 Node 来构建 React 和 Electron。

推荐安装当前仍受支持的 Node 24 LTS；本项目最低要求 Node 22.12。安装后可任选一种方式安装 pnpm：

```bash
npm install --global pnpm@10.12.1
```

或者在带 Corepack 的 Node 版本中：

```bash
corepack enable
corepack prepare pnpm@10.12.1 --activate
```

验证：

```bash
node --version
pnpm --version
```

安装前端依赖：

```bash
pnpm install
```

## 六、准备环境变量

交付压缩包出于安全考虑不包含 `.env.local`。如果你在现有分支上直接解压覆盖，原文件会保留；如果先删除旧目录，请务必先备份它。不要把该文件发给别人或提交到公开仓库。

新机器上没有该文件时：

Windows：

```powershell
Copy-Item env.example .env.local
```

macOS / Linux：

```bash
cp env.example .env.local
```

至少配置一个模型供应商 Key，或者在应用设置界面录入。

## 七、运行项目

推荐命令：

```bash
pnpm dev
```

正常日志大致包含：

```text
VITE ... Local: http://127.0.0.1:5173/
[FastAPI] Application startup complete
```

单独测试 Python：

```bash
python -m backend.main
```

然后浏览器打开：

```text
http://127.0.0.1:8765/api/health
http://127.0.0.1:8765/api/docs
```

## 八、打包 Python 后端

```bash
python scripts/build-python-backend.py
```

成功后会生成：

```text
python-dist/multi-agent-backend.exe    # Windows
python-dist/multi-agent-backend        # macOS/Linux
```

这个文件已经包含 Python 解释器和后端依赖，Electron 安装包会把它放进 resources/backend。

## 九、打包桌面应用

```bash
pnpm verify
pnpm electron:make
```

Windows 也可双击或运行：

```powershell
.\build-windows-installer.ps1
```

最终安装包位于 `release/`。

## 十、依赖安装失败排查

### pip 下载慢或超时

先升级 pip，再重试：

```bash
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.txt
```

企业网络需要代理时，在当前终端正确设置 `HTTPS_PROXY` 后重试。不要把带账号密码的代理写进 Git。

### `No module named backend`

你不在项目根目录。先 `cd` 到包含 `package.json` 和 `backend` 文件夹的目录。

### `No module named PyInstaller`

```bash
python -m pip install -r requirements-dev.txt
```

### Electron 找不到 Python

确认 `.venv` 位于项目根目录，或者设置：

Windows：

```powershell
$env:PYTHON_EXECUTABLE="C:\完整路径\.venv\Scripts\python.exe"
pnpm dev
```

macOS / Linux：

```bash
PYTHON_EXECUTABLE="$PWD/.venv/bin/python" pnpm dev
```

### 删除后重装虚拟环境

虚拟环境损坏时可以安全重建；不要删除源代码和 `.env.local`。

Windows：

```powershell
Remove-Item -Recurse -Force .venv
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
```

macOS / Linux：

```bash
rm -rf .venv
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
```
