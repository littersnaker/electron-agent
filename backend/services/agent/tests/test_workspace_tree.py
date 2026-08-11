"""工作区目录遍历剪枝与截断测试。"""

from __future__ import annotations

from backend.services.agent.shared.workspace_tools import render_workspace_tree
from backend.services.workspace.indexer import iter_project_files


def test_iter_project_files_prunes_ignored_directories(tmp_path) -> None:
    """遍历时必须在进入 node_modules/.pnpm-store 前剪枝，而不是先全量扫描。"""

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.ts").write_text("x", encoding="utf-8")
    ignored = tmp_path / "node_modules" / "pkg"
    ignored.mkdir(parents=True)
    (ignored / "b.ts").write_text("y", encoding="utf-8")
    store = tmp_path / ".pnpm-store"
    store.mkdir()
    (store / "c.ts").write_text("z", encoding="utf-8")

    relative_paths = list(iter_project_files(tmp_path))

    assert "src/a.ts" in relative_paths
    assert all("node_modules" not in path and ".pnpm-store" not in path for path in relative_paths)


def test_render_workspace_tree_respects_limit(tmp_path) -> None:
    """目录树截断后仍保留提示，避免把全量文件清单塞进模型。"""

    for index in range(20):
        (tmp_path / f"file_{index}.ts").write_text("x", encoding="utf-8")

    tree = render_workspace_tree(tmp_path, limit=5)
    lines = [
        line
        for line in tree.splitlines()
        if line and not line.startswith("（")
    ]

    assert len(lines) <= 5
    assert "已按调用方要求截断" in tree
