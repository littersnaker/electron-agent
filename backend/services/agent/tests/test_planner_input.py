"""Planner Input Builder 测试。"""

from backend.services.agent.planner.planner_context import build_planner_prompt
from backend.services.agent.planner.planner_input import (
    PlannerInput,
    PlannerInputBuilder,
)


class TestPlannerInput:
    def test_to_prompt_basic(self):
        """验证 test to prompt basic 场景的输入、执行结果与兼容行为。"""
        inp = PlannerInput(user_goal="添加用户登录功能")
        prompt = inp.to_prompt()
        assert "User Goal" in prompt
        assert "添加用户登录功能" in prompt

    def test_to_prompt_with_metadata(self):
        """验证 test to prompt with metadata 场景的输入、执行结果与兼容行为。"""
        inp = PlannerInput(
            user_goal="目标",
            project_metadata={"language": "Python", "framework": "FastAPI"},
        )
        prompt = inp.to_prompt()
        assert "Python" in prompt
        assert "FastAPI" in prompt


class TestPlannerInputBuilder:
    def test_build_basic(self):
        """验证 test build basic 场景的输入、执行结果与兼容行为。"""
        builder = PlannerInputBuilder()
        result = builder.build(user_goal="添加登录")
        assert result.user_goal == "添加登录"
        assert isinstance(result.project_metadata, dict)

    def test_build_with_tree(self):
        """验证 test build with tree 场景的输入、执行结果与兼容行为。"""
        builder = PlannerInputBuilder()
        tree = "src/\n  main.py\n  utils.py\n"
        result = builder.build(user_goal="test", project_tree=tree)
        assert result.project_metadata.get("total_files", 0) >= 0

    def test_build_with_relevant_files(self):
        """验证 test build with relevant files 场景的输入、执行结果与兼容行为。"""
        builder = PlannerInputBuilder()
        result = builder.build(
            user_goal="test",
            relevant_file_paths=["src/main.py", "node_modules/x/index.js"],
            file_contents={"src/main.py": "print('hello')"},
        )
        assert len(result.relevant_files) == 1  # node_modules 被过滤
        assert result.relevant_files[0]["path"] == "src/main.py"

    def test_build_filters_completed_works(self):
        """验证 test build filters completed works 场景的输入、执行结果与兼容行为。"""
        builder = PlannerInputBuilder()
        result = builder.build(
            user_goal="test",
            existing_works=[
                {"id": "W001", "status": "succeeded", "title": "完成"},
                {"id": "W002", "status": "pending", "title": "待办"},
            ],
        )
        assert len(result.existing_work_summary) == 1
        assert result.existing_work_summary[0]["id"] == "W002"

    def test_build_limits_files(self):
        """验证 test build limits files 场景的输入、执行结果与兼容行为。"""
        builder = PlannerInputBuilder(max_files=2)
        paths = [f"file_{i}.py" for i in range(10)]
        contents = {p: f"content {i}" for i, p in enumerate(paths)}
        result = builder.build(
            user_goal="test",
            relevant_file_paths=paths,
            file_contents=contents,
        )
        assert len(result.relevant_files) <= 2

    def test_build_with_memory_notes(self):
        """验证 test build with memory notes 场景的输入、执行结果与兼容行为。"""
        builder = PlannerInputBuilder()
        result = builder.build(
            user_goal="test",
            memory_notes=["- episodic: 用户之前问过购物车优化，结论是懒加载。"],
        )
        prompt = result.to_prompt()
        assert "Related Memory" in prompt
        assert "懒加载" in prompt

    def test_planner_prompt_includes_memory_blocks(self):
        """验证 build_planner_prompt 会把 Memory 段落带给 Planner。"""
        context = """## Skill · workspace-code-agent@1
遵守工程约束。
## Memory · episodic · mem_abc
Agent=coding
Request=用户之前问过如何优化购物车加载速度。
Status=completed
--- FILE: src/cart.ts ---
export const cart = []
"""
        prompt = build_planner_prompt(
            user_request="优化购物车加载速度",
            project_tree="src/cart.ts\n",
            initial_context=context,
        )
        assert "Related Memory" in prompt
        assert "购物车加载速度" in prompt

    def test_build_preserves_large_files(self):
        """单次任务内 Planner 输入不截断大文件，完整保留内容。"""
        builder = PlannerInputBuilder(max_file_chars=10)
        result = builder.build(
            user_goal="test",
            relevant_file_paths=["big.py"],
            file_contents={"big.py": "x" * 100_000},
        )
        assert len(result.relevant_files[0]["content"]) == 100_000

    def test_build_includes_file_inventory(self):
        """楠岃瘉 Project File Inventory 只携带路径，且过滤无关注录。"""
        builder = PlannerInputBuilder()
        tree = "\n".join(
            [
                "app/page.tsx",
                "app/cart/CartPage.tsx",
                "node_modules/pkg/index.js",
                "dist/bundle.js",
            ]
        )
        result = builder.build(user_goal="test", project_tree=tree)
        assert "app/cart/CartPage.tsx" in result.file_inventory
        assert "app/page.tsx" in result.file_inventory
        assert all("node_modules" not in p for p in result.file_inventory)
        assert all("dist" not in p for p in result.file_inventory)
        prompt = result.to_prompt()
        assert "Project File Inventory" in prompt
        assert "- app/cart/CartPage.tsx" in prompt
