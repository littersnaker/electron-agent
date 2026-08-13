# Multi-agent Desktop — Electron + React + FastAPI

This is a desktop AI Agent workspace migrated from the original **Electron + Next.js** project:

- Desktop shell: Electron
- UI: React + Vite + TypeScript
- Business backend: Python + FastAPI
- Local database: SQLite
- Python distribution: PyInstaller onedir backend directory (avoids unpacking on every launch)
- Desktop installer: electron-builder

You need Python during development; the final installer ships its own Python backend executable, so end users do not need Python installed.

Beginner setup and related guides (Chinese):

- [README_CN.md](./README_CN.md)
- [INSTALL_PYTHON_CN.md](./INSTALL_PYTHON_CN.md)
- [MIGRATION_GUIDE_CN.md](./MIGRATION_GUIDE_CN.md)

## 1. Fastest start

For the full walkthrough see [INSTALL_PYTHON_CN.md](./INSTALL_PYTHON_CN.md). You can also run the semi-automated setup script first:

```powershell
# Windows
.\setup-windows.ps1
```

```bash
# macOS / Linux
./setup-macos-linux.sh
```

Once Node, pnpm and Python are installed, run from the project root:

```powershell
# Windows PowerShell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.txt
pnpm install
Copy-Item env.example .env.local   # Do not overwrite if .env.local already exists
pnpm dev
```

macOS / Linux:

```bash
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.txt
pnpm install
cp env.example .env.local          # Do not overwrite if .env.local already exists
pnpm dev
```

`pnpm dev` clears the old `dist`, Electron build artifacts and dev cache first, then starts simultaneously:

1. Vite React hot-reload server;
2. Uvicorn Python source hot-reload server;
3. the `config/chat-models.json` model sync watcher;
4. the Electron main-process compile and auto-restart watcher.

If a dev port is occupied by an old process it stops and prints a PID lookup hint instead of silently connecting to a stale backend.

## 2. Project structure

```text
.
├─ app/                         React pages, components, hooks, frontend types
├─ backend/                     Python FastAPI business services
│  ├─ api/                      HTTP/SSE interface layer
│  ├─ core/                     config, logging, request audit, background task lifecycle
│  ├─ schemas/                  Pydantic request/response models
│  ├─ services/
│  │  ├─ agent/                 Unified Agent Runtime (planner/worker/loop/shared/reflection)
│  │  ├─ commerce/              market research, review analysis, Listing drafts
│  │  ├─ llm/                   multi-model gateway (OpenAI-compatible / Gemini)
│  │  ├─ mcp/                   MCP service discovery
│  │  ├─ media/                 image/video generation
│  │  ├─ skills/                external Skill install & enablement
│  │  ├─ tools/                 Tool Gateway (search/read/inspect/edit/run/filesystem)
│  │  └─ workspace/             project, index, SQLite, completed-work registry
│  ├─ tests/                    Python smoke tests
│  └─ main.py                   FastAPI entry point
├─ electron/                    Electron main process, preload, IPC
├─ scripts/                     build scripts
├─ public/                      icons and static assets
├─ main.tsx                     Vite React entry
├─ package.json                 Node dependencies and commands
├─ requirements.txt             Python runtime dependencies
├─ requirements-dev.txt         Python dev/package dependencies
└─ electron-builder.yml         desktop installer configuration
```

## 3. Development commands

```bash
# Recommended: run React, Electron and FastAPI together
pnpm dev

# Backend only
python -m backend.main

# React only (start the backend in another terminal)
pnpm frontend:dev

# Python lint
pnpm backend:check

# Python smoke tests
pnpm backend:test

# Frontend type check
pnpm typecheck

# Electron type check
pnpm electron:typecheck

# Vite production build
pnpm build
```

When FastAPI runs standalone:

- Liveness probe: `http://127.0.0.1:8765/api/health/live`
- Detailed health check: `http://127.0.0.1:8765/api/health`
- API docs: `http://127.0.0.1:8765/api/docs`

## 4. Building the desktop installer

Before the first build, make sure `requirements-dev.txt` is installed because it contains PyInstaller.

```bash
# Run the full check first
pnpm verify

# Installer for the current OS
pnpm electron:make

# Windows x64
pnpm electron:make:win

# macOS
pnpm electron:make:mac

# Linux
pnpm electron:make:linux
```

The build pipeline produces, in order:

1. `.electron/`: Electron main-process JavaScript;
2. `dist/`: Vite React static pages;
3. `python-dist/multi-agent-backend/`: the Python backend executable and its `_internal` runtime dependencies;
4. `release/`: the final installer.

Production installers do not copy `.env.local` directly. When building the Python backend, the script only extracts the Bailian `DASHSCOPE_API_KEY` and the optional `DASHSCOPE_BASE_URL` into a generated credentials module embedded in the PyInstaller executable. Users without a personal Bailian key automatically use this fallback; once a personal key is configured it takes priority. See [BUILTIN_BAILIAN_FALLBACK_CN.md](./BUILTIN_BAILIAN_FALLBACK_CN.md).

## 5. How to read the Python backend

### `backend/main.py`

The equivalent of `server.ts`: creates FastAPI, registers middleware, initializes SQLite, loads routes, and serves the React static pages in production.

### `backend/api/`

The equivalent of the old Next.js API Routes. This directory only:

- receives requests;
- validates parameters;
- calls services;
- converts exceptions;
- returns JSON or SSE.

Do not pile complex business logic into API files.

### `backend/services/`

The real business layer, split by Agent, LLM, workspace, media, Commerce and MCP to avoid oversized files.

### `backend/schemas/`

The equivalent of TypeScript interfaces, but validated at runtime against JSON sent from the frontend.

## 6. Current capabilities

- Multi-model configuration and model list, auto routing with provider circuit breakers;
- Streaming chat / SSE;
- Native Function Calling: tool schema passthrough, streaming tool_calls accumulation (compatible with DeepSeek's id-less chunks);
- Project create/read and SQLite persistence (versioned migrations + WAL);
- Project file indexing and context search;
- Full Code Agent pipeline: intent classifier → Planner WorkList → parallel scheduling (same-file conflict serialization) → transactional edits → re-plan only the failed items → checkpoint resume → final quality gate;
- Completed-work registry: deterministic skip for a work whose title and artifacts already exist, preventing re-runs;
- Execution guard: duplicate-action rejection, read-only stall warning, iteration budget and hard token stop-loss;
- Background task lifecycle: reviews/memory evaluation/indexing registered and drained on shutdown, eliminating "Event loop is closed";
- Agent Trace / observability and request audit log;
- Memory system: episodic / semantic / task memories, async post-execution review distilling reusable knowledge;
- Commerce market research: TalorData SERP + Amazon (SP-API first, public crawler fallback) + TikTok Shop / 1688 official APIs;
- Amazon review analysis: top products by review count get public comments collected, rating distribution + sentiment topics (LLM-enhanced for the first product), degrading to clearly-labeled demo samples;
- Explicit demo mode when no data source is configured;
- Listing copy draft demo (pending / confirmed / rejected state machine, never publishes);
- MCP Server / tool catalog discovery;
- External Skill discovery, GitHub bulk install and enablement config;
- Electron directory picker, window controls and PDF export;
- SQLite and full-disk scans off the event loop: DB operations and file-tree traversal run via `asyncio.to_thread`, so SSE streaming is no longer blocked.

## 7. Migration boundaries you should know

1. MCP is currently discovery-and-display only; the Code Agent does not yet auto-execute remote MCP tools.
2. The Listing feature only generates copy and never publishes products to a real marketplace.
3. TikTok Shop and 1688 are wired to their official APIs (real product samples once credentials are configured); Temu and Keepa only show credential placeholders with no real API client yet.
4. Without TalorData or an available Amazon source, market research returns data flagged `runMode: demo`; review analysis likewise degrades to clearly-labeled demo samples and never fakes real research results.
5. Model providers may change model IDs; if a provider returns "model not found", update the mapping in `config/chat-models.json` (provider config lives in `config/providers.json`).

## 8. Code conventions

- Python business files stay under 500 lines;
- Every Python function/method has a Chinese docstring;
- Every new Electron/Vite utility function has a Chinese JSDoc;
- API / business / data-access layering;
- User secrets are read from request headers, environment variables or local settings; Bailian may also use a shared fallback embedded at build time;
- File writes must go through a proposal and manual approval;
- Media downloads block localhost, private networks and dangerous redirects.

## 9. FAQ

### `python` not found

On Windows try first:

```powershell
py -3.13 --version
```

On macOS/Linux try first:

```bash
python3.13 --version
```

### PowerShell refuses to activate the virtual environment

Loosen the policy for the current terminal only:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

Or skip activation entirely and call the venv interpreter directly:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
```

### Electron shows a blank page after FastAPI starts

Check in order:

```bash
python -m backend.main
pnpm frontend:dev
pnpm electron:compile
```

Then open `/api/health` and look at the `[FastAPI]`-prefixed logs in the terminal.

### Port already in use

Electron picks another port automatically. Only when you run `python -m backend.main` on its own do you need to edit `BACKEND_PORT` in `.env.local`.

### "Python backend not found" when the installer starts

The onedir backend at `python-dist/multi-agent-backend/` was not produced before packaging. Run:

```bash
python scripts/build-python-backend.py
pnpm electron:make
```

More migration notes: [MIGRATION_GUIDE_CN.md](./MIGRATION_GUIDE_CN.md); checks performed so far: [VALIDATION_REPORT_CN.md](./VALIDATION_REPORT_CN.md).

Packaged backend cold-start and health-check notes: [PACKAGED_BACKEND_STARTUP_FIX_CN.md](./PACKAGED_BACKEND_STARTUP_FIX_CN.md).

## Local hot reload and model editing

Local development uses `pnpm dev` for everything. React, Python, the model JSON and the Electron main process all hot reload. Chat models are edited in `config/chat-models.json`. See [HOT_RELOAD_MODEL_GUIDE_CN.md](./HOT_RELOAD_MODEL_GUIDE_CN.md).
