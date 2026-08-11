"""Project Harness 的框架识别、Skill 注入和预读测试。"""

from __future__ import annotations

from pathlib import Path

from backend.services.agent.harness import build_project_harness, build_work_seed_context
from backend.services.agent.shared.work_models import WorkItem


def test_harness_detects_taro_skills_and_quality_commands(tmp_path: Path) -> None:
    """Harness 应从少量清单提取稳定工程事实，而不是把完整项目送入模型。"""

    (tmp_path / "package.json").write_text(
        """{
          "dependencies": {"@tarojs/taro": "4.0.0", "react": "19.0.0"},
          "scripts": {"lint": "eslint src", "typecheck": "tsc --noEmit", "build": "taro build"}
        }""",
        "utf-8",
    )
    (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'", "utf-8")
    (tmp_path / "src/pages/cart").mkdir(parents=True)
    (tmp_path / "src/pages/cart/index.tsx").write_text("export const Cart = () => null;", "utf-8")
    (tmp_path / "src/app.config.ts").write_text("export default { pages: [] };", "utf-8")
    (tmp_path / ".env.local").write_text("SECRET=never-read", "utf-8")
    runtime_context = """## Skill · apple-miniapp-ui@1.0.0
使用 44px 触控区和四态页面。
## Memory
不应进入 Harness。
"""

    harness = build_project_harness(
        root=tmp_path,
        request_text="完善商城购物车 UI",
        runtime_context=runtime_context,
    )
    seed = build_work_seed_context(
        root=tmp_path,
        harness=harness,
        work=WorkItem("W001", "购物车状态与交互", "完善购物车页面"),
    )

    assert harness.framework == "Taro 小程序"
    assert harness.package_manager == "pnpm"
    assert harness.quality_commands == [
        "pnpm run lint",
        "pnpm run typecheck",
        "pnpm run build",
    ]
    assert "apple-miniapp-ui" in harness.skill_ids
    assert "src/pages/cart/index.tsx" in seed
    assert "SECRET=never-read" not in seed
    assert seed.count("--- FILE:") <= 8
