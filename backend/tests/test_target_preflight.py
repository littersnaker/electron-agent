"""targetFiles 确定性预检测试。"""

from backend.services.agent.target_preflight import (
    count_project_source_files,
    extract_tree_paths,
    is_greenfield_project,
    preflight_plan_works,
    probe_target_files,
)
from backend.services.agent.work_models import WorkItem


PROJECT_PATHS = [
    "app/cart/CartPage.tsx",
    "app/cart/CartContext.tsx",
    "app/cart/CartItem.tsx",
    "app/home/HomePage.tsx",
    "app/layout.tsx",
    "lib/api/mock.ts",
    "lib/api/client.ts",
    "lib/theme/tokens.ts",
    "backend/services/agent/work_worker.py",
    "README.md",
]


def _work(**kwargs) -> WorkItem:
    defaults = {
        "id": "W001",
        "title": "任务",
        "objective": "完成修改",
    }
    defaults.update(kwargs)
    return WorkItem(**defaults)


class TestExtractTreePaths:
    def test_parses_plain_path_lines(self):
        tree = "\n".join(["app/page.tsx", "lib/utils.ts", "（目录树已按调用方要求截断）"])
        paths = extract_tree_paths(tree)
        assert "app/page.tsx" in paths
        assert "lib/utils.ts" in paths
        assert not any("截断" in path for path in paths)

    def test_filters_ignored_dirs_and_directories(self):
        tree = "\n".join(
            [
                "src/main.py",
                "node_modules/pkg/index.js",
                ".venv/lib/site.py",
                "dist/bundle.js",
                "app/",
            ]
        )
        paths = extract_tree_paths(tree)
        assert "src/main.py" in paths
        assert all("node_modules" not in p for p in paths)
        assert all(".venv" not in p for p in paths)
        assert all("dist" not in p for p in paths)
        assert all("app/" not in p for p in paths)


class TestGreenfieldDetection:
    def test_empty_project_is_greenfield(self):
        assert is_greenfield_project("")
        assert is_greenfield_project("app/\n")
        assert is_greenfield_project("package.json\napp/page.tsx\n")

    def test_real_project_is_not_greenfield(self):
        tree = "\n".join(
            [
                "app/page.tsx",
                "app/cart/CartPage.tsx",
                "app/home/HomePage.tsx",
                "lib/api/mock.ts",
                "lib/theme/tokens.ts",
                "backend/services/agent/work_worker.py",
                "README.md",
            ]
        )
        assert not is_greenfield_project(tree)
        assert count_project_source_files(tree) == 7


class TestProbeTargetFiles:
    def test_fills_from_path_token(self):
        work = _work(
            objective="检查 lib/api/mock.ts 是否完整，不足则补齐",
        )
        filled = probe_target_files(work, PROJECT_PATHS)
        assert "lib/api/mock.ts" in filled

    def test_fills_from_basename_word(self):
        work = _work(
            title="商品浏览页面",
            objective="更新 HomePage 的布局与样式",
        )
        filled = probe_target_files(work, PROJECT_PATHS)
        assert "app/home/HomePage.tsx" in filled

    def test_expands_directory_target(self):
        work = _work(
            title="购物车 UI",
            objective="完善购物车页面",
            target_files=["app/cart"],
        )
        filled = probe_target_files(work, PROJECT_PATHS)
        assert "app/cart/CartPage.tsx" in filled
        assert "app/cart/CartContext.tsx" in filled
        assert "app/cart/CartItem.tsx" in filled
        assert "app/layout.tsx" not in filled

    def test_keeps_declared_exact_files(self):
        work = _work(
            title="主题 tokens",
            objective="统一样式",
            target_files=["lib/theme/tokens.ts", "app/layout.tsx"],
        )
        filled = probe_target_files(work, PROJECT_PATHS)
        assert filled == ["lib/theme/tokens.ts", "app/layout.tsx"]

    def test_respects_limit(self):
        work = _work(
            title="全部页面",
            objective="为所有页面应用 Apple 风格",
            target_files=["app"],
            execution_type="coding",
        )
        filled = probe_target_files(work, PROJECT_PATHS, limit=2)
        assert len(filled) <= 2
        assert filled == filled[:2]

    def test_empty_when_no_match(self):
        work = _work(
            title="数据库迁移",
            objective="新增 users 表迁移脚本",
        )
        assert probe_target_files(work, PROJECT_PATHS) == []


class TestPreflightPlanWorks:
    def test_fills_only_coding_agent_works(self):
        coding = _work(
            id="W001",
            execution_type="coding",
            objective="更新 CartPage 样式",
        )
        validation = _work(
            id="W002",
            execution_type="validation",
            objective="运行测试",
            validation_commands=["pytest"],
        )
        artifact = _work(
            id="W003",
            execution_type="artifact",
            objective="生成 mock 数据",
        )
        tree = "\n".join(PROJECT_PATHS)
        notes = preflight_plan_works([coding, validation, artifact], tree)
        assert coding.target_files
        assert validation.target_files == []
        assert artifact.target_files == []
        assert notes
        assert "W001" in notes[0]

    def test_no_notes_when_already_filled(self):
        work = _work(
            execution_type="coding",
            target_files=["app/home/HomePage.tsx"],
        )
        tree = "\n".join(PROJECT_PATHS)
        notes = preflight_plan_works([work], tree)
        assert work.target_files == ["app/home/HomePage.tsx"]
        assert notes == []
