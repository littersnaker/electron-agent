"""Code Agent 提示词优化、WorkList 与多轮工具循环回归测试。"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.services.agent.loop.runner import stream_autonomous_loop
from backend.services.agent.planner.task_planner import (
    CodeTaskPlan,
    ReplanResult,
    WorkItem,
    WorkLedger,
    prepare_code_task,
)
from backend.services.agent.shared.command_runner import validate_command
from backend.services.agent.shared.loop_protocol import parse_agent_action
from backend.services.agent.shared.workspace_tools import apply_edit_operations
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.types import LlmUsage


def _plan(*works: WorkItem) -> CodeTaskPlan:
    """创建测试使用的最小任务规格。"""

    return CodeTaskPlan(
        raw_request="完成代码修改",
        optimized_prompt="读取真实项目后完成代码修改并验证",
        objective="完成代码修改",
        constraints=["不修改用户给出的 model 值"],
        acceptance_criteria=["文件实际落盘"],
        non_goals=[],
        validation_commands=[],
        works=list(works) or [WorkItem("W001", "完成修改", "完成代码修改")],
    )


def test_edit_batch_is_not_limited_to_eight_files(tmp_path: Path) -> None:
    """验证一轮可以安全处理超过 8 个文件。"""

    raw = {
        "action": "edit",
        "workId": "W001",
        "summary": "创建模块",
        "operations": [
            {
                "type": "write",
                "path": f"src/module_{index}.py",
                "content": f"VALUE = {index}\n",
            }
            for index in range(12)
        ],
    }
    action = parse_agent_action(json.dumps(raw))
    result = apply_edit_operations(tmp_path, action.operations)

    assert action.work_id == "W001"
    assert len(result.changed_files) == 12
    assert (tmp_path / "src" / "module_11.py").read_text("utf-8") == "VALUE = 11\n"


def test_full_auto_command_policy_blocks_install_and_shell() -> None:
    """验证全自动模式不能静默安装依赖或使用 shell 管道。"""

    _parts, install_error = validate_command("pnpm install", Path.cwd())
    _parts, pipe_error = validate_command("pnpm test | more", Path.cwd())
    _parts, test_error = validate_command("pnpm test", Path.cwd())

    assert install_error
    assert pipe_error
    assert test_error is None


@pytest.mark.asyncio
async def test_prompt_optimizer_preserves_explicit_model_and_base_url(monkeypatch) -> None:
    """验证提示词优化会补全规格，但不会改写用户明确参数。"""

    captured: dict[str, str] = {}

    async def fake_complete(**kwargs):
        """返回包含显式参数的优化任务规格。"""

        captured["prompt"] = kwargs["messages"][-1].content
        payload = {
            "optimizedPrompt": (
                "保持 model=qwen3.7-plus，使用 Base URL "
                "https://example.test/compatible-mode/v1，并修复路由。"
            ),
            "objective": "修复模型路由",
            "constraints": ["model 和 Base URL 原样保留"],
            "acceptanceCriteria": ["路由测试通过"],
            "nonGoals": [],
            "validationCommands": ["python -m pytest"],
            "worklist": [
                {
                    "id": "W001",
                    "title": "修复路由",
                    "objective": "修改路由并测试",
                    "acceptanceCriteria": ["测试通过"],
                    "dependencies": [],
                }
            ],
        }
        return (
            json.dumps(payload, ensure_ascii=False),
            LlmUsage(prompt=20, completion=10, total=30),
            SimpleNamespace(name="Planner Model"),
        )

    monkeypatch.setattr("backend.services.agent.planner.task_planner.GATEWAY.complete", fake_complete)
    prepared = await prepare_code_task(
        user_request=(
            "不要修改 model=qwen3.7-plus，Base URL 是 "
            "https://example.test/compatible-mode/v1，修复路由"
        ),
        project_tree="backend/router.py",
        initial_context="router code",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
    )

    assert "model=qwen3.7-plus" in prepared.plan.optimized_prompt
    assert "https://example.test/compatible-mode/v1" in prepared.plan.optimized_prompt
    assert prepared.plan.works[0].id == "W001"
    assert "model=qwen3.7-plus" in captured["prompt"]


@pytest.mark.asyncio
async def test_planner_receives_candidate_files_context(monkeypatch) -> None:
    """传入候选文件时，Planner 系统提示词应包含候选文件上下文。"""

    captured: list[str] = []

    async def fake_complete(**kwargs):
        captured.append(kwargs["messages"][0].content)
        return (
            json.dumps(
                {
                    "optimizedPrompt": "创建电商小程序",
                    "objective": "创建电商小程序",
                    "constraints": [],
                    "acceptanceCriteria": [],
                    "nonGoals": [],
                    "validationCommands": [],
                    "worklist": [
                        {
                            "id": "W001",
                            "title": "整站生成",
                            "objective": "创建全部页面",
                            "targetFiles": ["src/cart/CartPage.tsx"],
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            LlmUsage(prompt=20, completion=10, total=30),
            SimpleNamespace(name="Planner Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.planner.task_planner.GATEWAY.complete",
        fake_complete,
    )
    await prepare_code_task(
        user_request="做一个电商小程序",
        project_tree="",
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        candidate_files=["src/cart/CartPage.tsx", "src/home/HomePage.tsx"],
    )

    assert captured
    assert "候选文件" in captured[0]
    assert "src/cart/CartPage.tsx" in captured[0]


def test_replan_keeps_successful_work_immutable() -> None:
    """验证重规划只能调整失败/待办 Work，不能让成功 Work 重复执行。"""

    ledger = WorkLedger(
        [
            WorkItem("W001", "已完成模块", "完成模块 A"),
            WorkItem("W002", "失败模块", "完成模块 B"),
        ]
    )
    ledger.begin("W001")
    ledger.succeed("W001", "模块 A 已落盘")
    ledger.begin("W002")
    ledger.fail("W002", "测试失败")
    before = ledger.snapshot()

    ledger.apply_replan(
        ReplanResult(
            reason="只重试失败模块",
            retry_items=[WorkItem("W002", "修复模块 B", "根据测试输出修复")],
            new_items=[],
            skipped_ids=[],
            usage=LlmUsage(),
            model_name="Planner",
        )
    )
    after = ledger.snapshot()

    assert before["succeeded"] == 1
    assert after["succeeded"] == 1
    assert ledger.get("W001").status == "succeeded"  # type: ignore[union-attr]
    assert ledger.get("W002").status == "pending"  # type: ignore[union-attr]
    assert ledger.get("W001").attempts == 1  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_agent_loop_can_edit_many_files_and_finish(tmp_path: Path, monkeypatch) -> None:
    """验证代理可修改 10 个文件并完成单 Work。"""

    (tmp_path / "README.md").write_text("demo\n", "utf-8")
    responses = iter(
        [
            {"action": "read", "workId": "W001", "paths": ["README.md"]},
            {
                "action": "edit",
                "workId": "W001",
                "summary": "创建十个模块",
                "operations": [
                    {
                        "type": "write",
                        "path": f"pkg/item_{index}.py",
                        "content": f"ITEM = {index}\n",
                    }
                    for index in range(10)
                ],
            },
            {
                "action": "complete_work",
                "workId": "W001",
                "summary": "十个模块均已创建",
            },
            {
                "action": "finish",
                "summary": "已按要求创建十个模块。",
                "tests": ["建议执行 python -m compileall pkg"],
            },
        ]
    )

    async def fake_complete(**_kwargs):
        """依次返回单 Work 的工具动作。"""

        return (
            json.dumps(next(responses), ensure_ascii=False),
            LlmUsage(prompt=10, completion=5, total=15),
            SimpleNamespace(name="Fake Coding Model"),
        )

    monkeypatch.setattr("backend.services.agent.loop.runner.GATEWAY.complete", fake_complete)
    result = None
    async for event in stream_autonomous_loop(
        root=tmp_path,
        task_plan=_plan(WorkItem("W001", "创建模块", "创建十个模块")),
        initial_context="--- README.md ---\ndemo",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
    ):
        if event.kind == "result":
            result = event.result

    assert result is not None
    assert len(result.changed_files) == 10
    assert result.iterations == 3
    assert result.usage.total == 45
    assert result.worklist["succeeded"] == 1


@pytest.mark.asyncio
async def test_empty_project_generation_work_uses_one_shot_path(
    tmp_path: Path, monkeypatch
) -> None:
    """空项目中无 targetFiles 的“开发”类 Work 应走一键生成，不进多轮循环。"""

    responses = iter(
        [
            {
                "action": "edit",
                "workId": "W001",
                "summary": "创建购物车页",
                "operations": [
                    {
                        "type": "write",
                        "path": "src/pages/cart.tsx",
                        "content": "export default function Cart() { return null; }\n",
                    }
                ],
            },
            {"verdict": "complete", "summary": "购物车页已创建"},
        ]
    )

    async def fake_complete(**_kwargs):
        return (
            json.dumps(next(responses), ensure_ascii=False),
            LlmUsage(prompt=10, completion=5, total=15),
            SimpleNamespace(name="Fake Coding Model"),
        )

    monkeypatch.setattr("backend.services.agent.loop.runner.GATEWAY.complete", fake_complete)
    result = None
    async for event in stream_autonomous_loop(
        root=tmp_path,
        task_plan=_plan(WorkItem("W001", "购物车页开发", "开发购物车页面")),
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
    ):
        if event.kind == "result":
            result = event.result

    assert result is not None
    assert result.worklist["succeeded"] == 1
    # 一键生成 + 审查共 2 次模型调用（15 tokens/次），证明没有进入多轮循环。
    assert result.usage.total == 30
    assert (tmp_path / "src" / "pages" / "cart.tsx").is_file()


@pytest.mark.asyncio
async def test_empty_edit_feedback_leads_to_complete_work(
    tmp_path: Path, monkeypatch
) -> None:
    """空 operations 的 edit 应得到针对性反馈而不是协议失败，模型随后可正常完成。"""

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "CartPage.tsx").write_text(
        "// 购物车页面\n",
        "utf-8",
    )
    responses = iter(
        [
            {
                "action": "edit",
                "workId": "W001",
                "summary": "已满足，无需修改",
                "operations": [],
            },
            {"action": "complete_work", "workId": "W001", "summary": "无需修改"},
        ]
    )
    async def fake_complete(**_kwargs):
        return (
            json.dumps(next(responses), ensure_ascii=False),
            LlmUsage(prompt=10, completion=5, total=15),
            SimpleNamespace(name="Fake Coding Model"),
        )

    monkeypatch.setattr("backend.services.agent.loop.runner.GATEWAY.complete", fake_complete)
    result = None
    async for event in stream_autonomous_loop(
        root=tmp_path,
        task_plan=_plan(
            WorkItem(
                "W001",
                "购物车页开发",
                "开发购物车页面",
                target_files=["src/CartPage.tsx"],
            )
        ),
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
    ):
        if event.kind == "result":
            result = event.result

    assert result is not None
    assert result.worklist["succeeded"] == 1
    assert result.usage.total == 30


@pytest.mark.asyncio
async def test_non_empty_project_creation_work_uses_one_shot_create_missing(
    tmp_path: Path, monkeypatch
) -> None:
    """非空项目中无 targetFiles 的创建类 Work 应一次性全量创建缺失文件，不进多轮循环。"""

    (tmp_path / "src").mkdir()
    for index in range(6):
        (tmp_path / "src" / f"module_{index}.ts").write_text(
            f"export const value_{index} = {index};\n",
            "utf-8",
        )

    responses = iter(
        [
            {
                "action": "edit",
                "workId": "W001",
                "summary": "创建购物车页",
                "operations": [
                    {
                        "type": "write",
                        "path": "src/pages/cart.tsx",
                        "content": "export default function Cart() { return null; }\n",
                    }
                ],
            },
            {"verdict": "complete", "summary": "购物车页已创建"},
        ]
    )

    async def fake_complete(**_kwargs):
        return (
            json.dumps(next(responses), ensure_ascii=False),
            LlmUsage(prompt=10, completion=5, total=15),
            SimpleNamespace(name="Fake Coding Model"),
        )

    monkeypatch.setattr("backend.services.agent.loop.runner.GATEWAY.complete", fake_complete)
    result = None
    async for event in stream_autonomous_loop(
        root=tmp_path,
        task_plan=_plan(WorkItem("W001", "购物车页开发", "开发购物车页面")),
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
    ):
        if event.kind == "result":
            result = event.result

    assert result is not None
    assert result.worklist["succeeded"] == 1
    assert result.usage.total == 30
    assert (tmp_path / "src" / "pages" / "cart.tsx").is_file()


@pytest.mark.asyncio
async def test_failed_work_replans_with_full_snapshot_without_repeating_success(
    tmp_path: Path, monkeypatch
) -> None:
    """验证一个 Work 失败时，Planner 收到成功/失败/待办的完整 JSON。"""

    (tmp_path / "src").mkdir()
    for index in range(6):
        (tmp_path / "src" / f"seed_{index}.ts").write_text(
            f"export const seed_{index} = {index};\n",
            "utf-8",
        )

    responses = iter(
        [
            {
                "action": "edit",
                "workId": "W001",
                "summary": "完成 A",
                "operations": [
                    {"type": "write", "path": "a.py", "content": "A = 1\n"}
                ],
            },
            {"verdict": "complete", "summary": "A 完成"},
            {
                "action": "edit",
                "workId": "W002",
                "summary": "错误修改 B",
                "operations": [
                    {
                        "type": "replace",
                        "path": "missing.py",
                        "oldText": "x",
                        "newText": "y",
                    }
                ],
            },
            {
                "action": "edit",
                "workId": "W002",
                "summary": "再次错误修改 B",
                "operations": [
                    {
                        "type": "replace",
                        "path": "missing.py",
                        "oldText": "x",
                        "newText": "y",
                    }
                ],
            },
            {
                "reason": "保留 W001，仅重试 W002",
                "retry": [
                    {
                        "id": "W002",
                        "title": "修复 B",
                        "objective": "改为创建缺失文件",
                        "acceptanceCriteria": ["b.py 存在"],
                        "dependencies": ["W001"],
                    }
                ],
                "newWorks": [],
                "skip": [],
            },
            {
                "action": "edit",
                "workId": "W002",
                "summary": "完成 B",
                "operations": [
                    {"type": "write", "path": "b.py", "content": "B = 2\n"}
                ],
            },
            {"verdict": "complete", "summary": "B 完成"},
            {"action": "finish", "summary": "A 和 B 均完成", "tests": []},
        ]
    )
    planner_payloads: list[dict[str, object]] = []

    async def fake_complete(**kwargs):
        """同时模拟执行 Agent 与失败恢复 Planner。"""

        response = next(responses)
        if "fullWorkListSnapshot" in kwargs["messages"][-1].content:
            planner_payloads.append(json.loads(kwargs["messages"][-1].content))
        return (
            json.dumps(response, ensure_ascii=False),
            LlmUsage(prompt=10, completion=5, total=15),
            SimpleNamespace(name="Fake Coding Model"),
        )

    monkeypatch.setattr("backend.services.agent.loop.runner.GATEWAY.complete", fake_complete)
    monkeypatch.setattr("backend.services.agent.planner.task_planner.GATEWAY.complete", fake_complete)
    result = None
    async for event in stream_autonomous_loop(
        root=tmp_path,
        task_plan=_plan(
            WorkItem("W001", "模块 A", "完成 A"),
            WorkItem("W002", "模块 B", "完成 B", dependencies=["W001"]),
        ),
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
    ):
        if event.kind == "result":
            result = event.result

    assert planner_payloads
    snapshot = planner_payloads[0]["fullWorkListSnapshot"]
    assert isinstance(snapshot, dict)
    assert snapshot["succeeded"] == 1
    assert snapshot["failed"] == 1
    assert result is not None
    assert result.worklist["succeeded"] == 2
    first = result.worklist["items"][0]
    assert first["id"] == "W001"
    assert first["attempts"] == 1
    assert (tmp_path / "a.py").read_text("utf-8") == "A = 1\n"


@pytest.mark.asyncio
async def test_runtime_protocol_failure_retries_with_clean_attempt_state(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """协议错误应由 Runtime 干净重试，不能创建代码返工项或继承旧熔断。"""

    worker_calls = 0

    async def fake_complete(**kwargs):
        """第一次尝试连续返回无效协议，第二次尝试直接完成。"""

        nonlocal worker_calls
        system = kwargs["messages"][0].content
        if "并行 Worker" not in system:
            return (
                json.dumps({"action": "finish", "summary": "完成"}),
                LlmUsage(),
                SimpleNamespace(name="Final Model"),
            )
        worker_calls += 1
        content = (
            "我还需要继续分析"
            if worker_calls <= 2
            else json.dumps(
                {
                    "action": "complete_work",
                    "workId": "W001",
                    "summary": "第二次尝试已完成",
                }
            )
        )
        return (
            content,
            LlmUsage(prompt=10, completion=2, total=12),
            SimpleNamespace(name="Worker Model"),
        )

    monkeypatch.setattr("backend.services.agent.loop.runner.GATEWAY.complete", fake_complete)
    result = None
    async for event in stream_autonomous_loop(
        root=tmp_path,
        task_plan=_plan(WorkItem("W001", "完成修改", "完成一个小修改")),
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
    ):
        if event.kind == "result":
            result = event.result

    assert result is not None
    assert result.replans == 0
    assert result.worklist["succeeded"] == 1
    assert result.worklist["items"][0]["attempts"] == 2
    assert worker_calls == 3


@pytest.mark.asyncio
async def test_planner_adds_greenfield_directive_for_empty_project(monkeypatch) -> None:
    """空项目规划时，Planner 应收到“从零构建、整站生成”的强约束。"""

    captured: list[str] = []

    async def fake_complete(**kwargs):
        captured.append(kwargs["messages"][0].content)
        return (
            json.dumps(
                {
                    "optimizedPrompt": "创建电商小程序",
                    "objective": "创建电商小程序",
                    "constraints": [],
                    "acceptanceCriteria": ["页面创建完成"],
                    "nonGoals": [],
                    "validationCommands": [],
                    "worklist": [
                        {
                            "id": "W001",
                            "title": "整站生成",
                            "objective": "创建全部页面",
                            "targetFiles": ["src/pages/Home.tsx"],
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            LlmUsage(prompt=20, completion=10, total=30),
            SimpleNamespace(name="Planner Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.planner.task_planner.GATEWAY.complete",
        fake_complete,
    )
    await prepare_code_task(
        user_request="做一个电商小程序",
        project_tree="package.json\n",
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
    )
    assert captured
    assert "从零构建请求" in captured[0]
    assert "整站生成" in captured[0]


@pytest.mark.asyncio
async def test_planner_omits_greenfield_directive_for_existing_project(
    monkeypatch,
) -> None:
    """已有较多文件的项目不应触发从零构建约束。"""

    captured: list[str] = []

    async def fake_complete(**kwargs):
        captured.append(kwargs["messages"][0].content)
        return (
            json.dumps(
                {
                    "optimizedPrompt": "修改页面",
                    "objective": "修改页面",
                    "constraints": [],
                    "acceptanceCriteria": [],
                    "nonGoals": [],
                    "validationCommands": [],
                    "worklist": [
                        {
                            "id": "W001",
                            "title": "修改",
                            "objective": "修改页面",
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            LlmUsage(prompt=20, completion=10, total=30),
            SimpleNamespace(name="Planner Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.planner.task_planner.GATEWAY.complete",
        fake_complete,
    )
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
    await prepare_code_task(
        user_request="修改购物车页面",
        project_tree=tree,
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
    )
    assert captured
    assert "从零构建请求" not in captured[0]


@pytest.mark.asyncio
async def test_guard_stop_work_goes_to_replanner_with_failure_reason(
    tmp_path: Path, monkeypatch
) -> None:
    """守卫终止（连续重复上下文动作）应把失败原因送回 Planner 重规划，
    而不是像协议/超时那样原样重试。"""

    monkeypatch.setenv("CODE_AGENT_MAX_CONTEXT_ACTIONS", "4")
    monkeypatch.setenv("CODE_AGENT_MAX_GUARD_REJECTIONS", "2")
    # 本项目非空，走常规循环；调高停滞阈值，让“上下文动作超限”守卫先触发。
    monkeypatch.setenv("CODE_AGENT_MAX_STALL_ROUNDS", "10")
    (tmp_path / "src").mkdir()
    for index in range(7):
        (tmp_path / "src" / f"f{index}.py").write_text(f"V = {index}\n", "utf-8")

    responses = iter(
        [
            {"action": "read", "workId": "W001", "paths": ["src/f0.py"]},
            {"action": "read", "workId": "W001", "paths": ["src/f1.py"]},
            {"action": "read", "workId": "W001", "paths": ["src/f2.py"]},
            {"action": "read", "workId": "W001", "paths": ["src/f3.py"]},
            {"action": "read", "workId": "W001", "paths": ["src/f4.py"]},
            {"action": "read", "workId": "W001", "paths": ["src/f5.py"]},
            {"action": "read", "workId": "W001", "paths": ["src/f6.py"]},
            {
                "reason": "目标模糊导致守卫终止，重设计为只读审计",
                "retry": [
                    {
                        "id": "W001",
                        "title": "只读审计",
                        "objective": "仅审计 src 目录并输出结论",
                        "acceptanceCriteria": ["输出审计结论"],
                        "targetFiles": ["src/f0.py"],
                    }
                ],
                "newWorks": [],
                "skip": [],
            },
            {"action": "complete_work", "workId": "W001", "summary": "审计完成"},
            {"action": "complete_work", "workId": "W001", "summary": "审计完成"},
        ]
    )
    planner_payloads: list[dict[str, object]] = []

    async def fake_complete(**kwargs):
        """依次模拟 Worker 只读循环与失败恢复 Planner。"""

        response = next(responses)
        if "fullWorkListSnapshot" in kwargs["messages"][-1].content:
            planner_payloads.append(json.loads(kwargs["messages"][-1].content))
        return (
            json.dumps(response, ensure_ascii=False),
            LlmUsage(prompt=10, completion=5, total=15),
            SimpleNamespace(name="Fake Coding Model"),
        )

    monkeypatch.setattr("backend.services.agent.loop.runner.GATEWAY.complete", fake_complete)
    monkeypatch.setattr(
        "backend.services.agent.planner.task_planner.GATEWAY.complete", fake_complete
    )
    result = None
    async for event in stream_autonomous_loop(
        root=tmp_path,
        task_plan=_plan(WorkItem("W001", "完成修改", "完成一个小修改")),
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
    ):
        if event.kind == "result":
            result = event.result

    assert planner_payloads, "守卫终止后应触发一次重规划"
    failures = planner_payloads[0]["failures"]
    assert any(
        item.get("failureKind") == "guard" for item in failures
    ), "Planner 应收到 guard 失败类型"
    assert "执行守卫" in str(planner_payloads[0]["failureObservation"])
    assert result is not None
    assert result.replans == 1
    assert result.worklist["succeeded"] == 1
    assert result.worklist["items"][0]["attempts"] == 2
