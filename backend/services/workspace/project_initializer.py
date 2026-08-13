"""创建项目时的可选初始化：git init、README、最小前端骨架。

这些初始化由用户主动勾选触发，只在用户选择的目录内写文件。任何一步失败都
只记录 warning 并继续，不阻断项目创建（项目记录仍会写入 SQLite）。
"""

from __future__ import annotations

import json
import logging
import subprocess
from datetime import UTC, datetime
from pathlib import Path

LOGGER = logging.getLogger(__name__)

_FRONTEND_SKELETON_FILES: dict[str, str] = {
    "package.json": """{
  "name": "__NAME__",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vite": "^6.0.5"
  }
}
""",
    "tsconfig.json": """{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}
""",
    "vite.config.ts": """import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", strictPort: true },
});
""",
    "index.html": """<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>__NAME__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
""",
    "src/main.tsx": """import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <h1>__NAME__</h1>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
""",
    "src/index.css": "/* 在此编写全局样式 */\n",
    ".gitignore": """node_modules
dist
.env.local
.DS_Store
""",
}


def _safe_name(name: str) -> str:
    """把目录名转成合法的 npm 包名（小写、去非法字符）。"""

    import re

    normalized = re.sub(r"[^a-z0-9_.-]+", "-", name.strip().lower())
    return normalized.strip("-.") or "my-app"


def _run_git_init(root: Path) -> str | None:
    """在项目目录执行 git init；失败返回错误信息。"""

    try:
        result = subprocess.run(
            ["git", "init"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"git init 失败：{exc}"
    return None if result.returncode == 0 else f"git init 失败：{result.stderr.strip()[:200]}"


def _write_readme(root: Path, name: str) -> None:
    """生成 README.md 并跳过已存在的文件。"""

    target = root / "README.md"
    if target.exists():
        return
    created = datetime.now(UTC).strftime("%Y-%m-%d")
    target.write_text(
        f"# {name}\n\n> 由 Multi-agent Desktop 于 {created} 创建。\n\n"
        "## 快速开始\n\n```bash\npnpm install\npnpm dev\n```\n",
        encoding="utf-8",
    )


def _write_frontend_skeleton(root: Path, name: str) -> None:
    """生成最小 Vite + React + TypeScript 骨架；已存在的文件一律跳过。"""

    package_name = _safe_name(name)
    for relative, template in _FRONTEND_SKELETON_FILES.items():
        target = root / relative
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(template.replace("__NAME__", package_name), encoding="utf-8")


async def initialize_project(root: Path, options: list[str] | None) -> list[str]:
    """按用户选择的初始化选项执行；返回需要展示的 warning 列表。"""

    warnings: list[str] = []
    selected = [str(item).strip().lower() for item in (options or []) if str(item).strip()]
    if not selected:
        return warnings

    if "git" in selected:
        error = _run_git_init(root)
        if error:
            warnings.append(error)

    if "readme" in selected:
        try:
            _write_readme(root, root.name or "项目")
        except OSError as exc:
            warnings.append(f"README 生成失败：{exc}")

    if "skeleton" in selected:
        try:
            _write_frontend_skeleton(root, root.name or "项目")
        except OSError as exc:
            warnings.append(f"前端骨架生成失败：{exc}")

    if warnings:
        LOGGER.warning("项目初始化部分失败：%s", json.dumps(warnings, ensure_ascii=False))
    return warnings


__all__ = ["initialize_project"]
