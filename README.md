# Multi-agent Desktop — Electron + React + FastAPI

This branch migrates the original Electron + Next.js runtime to:

- Electron desktop shell
- React + Vite renderer
- Python + FastAPI business backend
- SQLite workspace storage
- PyInstaller-packaged local backend
- electron-builder installers

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

## Important migration boundaries

- MCP tools are discovered and displayed but are not automatically executed by the Code Agent.
- Commerce listing generation is a safe draft/demo and does not publish products.
- TalorData is used when configured; otherwise responses are explicitly marked as demo mode.
- Production installers do not embed `.env.local` secrets.

## Local hot reload and model editing

Use `pnpm dev` for local development. React, Python, the shared model JSON and Electron main process are watched. Chat models are edited in `config/chat-models.json`; see `HOT_RELOAD_MODEL_GUIDE_CN.md`.
