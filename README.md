# Multi-agent Desktop — Electron + React + FastAPI

A desktop multi-agent AI workspace built with:

- Electron desktop shell
- React + Vite renderer
- Python + FastAPI business backend
- SQLite workspace storage (versioned migrations, WAL)
- PyInstaller-packaged local backend
- electron-builder installers

The platform routes requests through a unified Agent Runtime to specialized agents
(coding, QA, commerce, media), splits code work into a parallel WorkList, and
recovers from failures through checkpoints and incremental re-planning.

Chinese setup and beginner documentation:

- [README_CN.md](./README_CN.md)
- [INSTALL_PYTHON_CN.md](./INSTALL_PYTHON_CN.md)
- [MIGRATION_GUIDE_CN.md](./MIGRATION_GUIDE_CN.md)

## Quick start

```bash
python -m venv .venv
# Activate .venv for your operating system.
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.txt
pnpm install
pnpm dev
```

## Key commands

```bash
pnpm dev                 # Fresh-cache Vite + reloading FastAPI + Electron watchers
python -m backend.main   # FastAPI only
pnpm backend:test        # Python smoke tests
pnpm verify              # Type checks, Python checks/tests, Vite build
pnpm electron:make       # Build installer for current OS
```

The packaged application starts `multi-agent-backend` from Electron resources. End users do not need a system Python installation.

## Capabilities

- **Code Agent**: intent classifier → Planner WorkList → parallel worker scheduling with same-file conflict serialization → transactional edits with version fingerprints → failure re-planning (only failed items) → checkpoint resume → final quality gate. Native OpenAI-compatible function calling with tool schemas.
- **Commerce Agent**: market research (TalorData SERP, Amazon search via SP-API/crawler fallback), **Amazon review analysis** (top products, rating distribution + sentiment, LLM-enhanced for the top product), and a safe Listing draft/demo workflow with a pending/confirmed/rejected state machine.
- **Multi-model routing**: Qwen / DeepSeek / Kimi / GLM / OpenAI with automatic fallback, provider circuit breakers, and streaming usage accounting.
- **Memory & review**: episodic/semantic/task memories in SQLite, async post-execution review that distills reusable knowledge, and an audit log for LLM requests.
- **Performance**: SQLite operations and filesystem scans run off the event loop via `asyncio.to_thread`; background tasks are tracked and drained on shutdown.

## Important boundaries

- MCP tools are discovered and displayed but are not automatically executed by the Code Agent.
- Commerce listing generation is a safe draft/demo and does not publish products.
- Market research uses TalorData when configured, Amazon public crawler as fallback; otherwise responses are explicitly marked as demo mode.
- Production installers do not embed `.env.local` secrets.

## Local hot reload and model editing

Use `pnpm dev` for local development. React, Python, the shared model JSON and Electron main process are watched. Chat models are edited in `config/chat-models.json`; see `HOT_RELOAD_MODEL_GUIDE_CN.md`.
