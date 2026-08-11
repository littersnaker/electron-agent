"""Code Agent 依赖图并行调度、优先级串行和波次重规划测试。"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from backend.services.agent.loop.runner import stream_autonomous_loop
from backend.services.agent.planner.task_planner import CodeTaskPlan, WorkItem
from backend.services.agent.shared.resource_coordinator import (
    WorkspaceResourceCoordinator,
    select_parallel_wave,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.types import LlmUsage


def _plan(*works: WorkItem) -> CodeTaskPlan:
    """创建测试用任务规格。"""

    return CodeTaskPlan(
        raw_request="并行完成项目修改",
        optimized_prompt="按依赖图并行完成互不冲突的 Work",
        objective="验证并行调度",
        constraints=[],
        acceptance_criteria=["全部 Work 完成"],
        non_goals=[],
        validation_commands=[],
        works=list(works),
    )


def _worker_id(system_prompt: str) -> str:
    """从单 Work 系统提示词识别当前 Worker。"""

    for work_id in ("W001", "W002", "W003"):
        if f'"id": "{work_id}"' in system_prompt:
            return work_id
    return ""


def test_parallel_wave_respects_target_file_conflicts_and_priority() -> None:
    """互不冲突 Work 同波执行；同文件 Work 按较高优先级先执行。"""

    independent = [
        WorkItem("W001", "模块 A", "修改 A", priority=20, target_files=["a.ts"]),
        WorkItem("W002", "模块 B", "修改 B", priority=10, target_files=["b.ts"]),
    ]
    assert [item.id for item in select_parallel_wave(independent, 4)] == ["W002", "W001"]

    conflicting = [
        WorkItem("W001", "低优先级", "修改共享文件", priority=50, target_files=["app.ts"]),
        WorkItem("W002", "高优先级", "修改共享文件", priority=5, target_files=["app.ts"]),
    ]
    assert [item.id for item in select_parallel_wave(conflicting, 4)] == ["W002"]


def test_rolling_candidates_mix_independent_and_conflicting_works() -> None:
    """滚动补位时应同时选择不冲突 Work，并让同文件冲突项等待高优先级完成。"""

    from backend.services.agent.shared.resource_coordinator import select_parallel_candidates

    ready = [
        WorkItem("W001", "模块 A", "修改 A", priority=20, target_files=["a.ts"]),
        WorkItem("W002", "模块 B", "修改 B", priority=10, target_files=["b.ts"]),
        WorkItem("W003", "低优先级共享", "修改共享文件", priority=50, target_files=["shared.ts"]),
        WorkItem("W004", "高优先级共享", "修改共享文件", priority=5, target_files=["shared.ts"]),
    ]
    selected = select_parallel_candidates(ready, [], 4)

    assert [item.id for item in selected] == ["W004", "W002", "W001"]
    assert "W003" not in {item.id for item in selected}


@pytest.mark.asyncio
async def test_runtime_resource_lock_orders_conflicting_writes_by_priority() -> None:
    """实际编辑路径未在 Planner 中声明时，运行时锁仍按优先级串行。"""

    coordinator = WorkspaceResourceCoordinator()
    order: list[str] = []
    blocker_ready = asyncio.Event()
    release_blocker = asyncio.Event()

    async def blocker() -> None:
        """先占用共享资源，让两个竞争者同时进入等待队列。"""

        async with coordinator.reserve({"shared.ts"}, owner="blocker", priority=0):
            blocker_ready.set()
            await release_blocker.wait()

    async def contender(owner: str, priority: int) -> None:
        """按指定优先级竞争同一个文件资源。"""

        async with coordinator.reserve({"shared.ts"}, owner=owner, priority=priority):
            order.append(owner)
            await asyncio.sleep(0)

    blocker_task = asyncio.create_task(blocker())
    await blocker_ready.wait()
    low = asyncio.create_task(contender("low", 80))
    high = asyncio.create_task(contender("high", 10))
    await asyncio.sleep(0)
    release_blocker.set()
    await asyncio.gather(blocker_task, low, high)

    assert order == ["high", "low"]


@pytest.mark.asyncio
async def test_independent_works_execute_concurrently(tmp_path, monkeypatch) -> None:
    """两个无依赖、无文件冲突的 Work 会同时进入模型工具循环。"""

    monkeypatch.setenv("CODE_AGENT_PARALLEL_WORKERS", "4")
    started: set[str] = set()
    both_started = asyncio.Event()
    active = 0
    max_active = 0

    async def fake_complete(**kwargs):
        """模拟两个 Worker 同时进入模型调用并立即完成。"""

        nonlocal active, max_active
        system = kwargs["messages"][0].content
        if "最终汇总器" in system:
            return (
                json.dumps({"action": "finish", "summary": "并行任务完成"}),
                LlmUsage(prompt=1, completion=1, total=2),
                SimpleNamespace(name="Final Model"),
            )
        work_id = _worker_id(system)
        active += 1
        max_active = max(max_active, active)
        started.add(work_id)
        if len(started) == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), timeout=1)
        await asyncio.sleep(0.02)
        active -= 1
        return (
            json.dumps(
                {
                    "action": "complete_work",
                    "workId": work_id,
                    "summary": f"{work_id} 完成",
                }
            ),
            LlmUsage(prompt=2, completion=1, total=3),
            SimpleNamespace(name="Worker Model"),
        )

    monkeypatch.setattr("backend.services.agent.loop.runner.GATEWAY.complete", fake_complete)
    result = None
    async for event in stream_autonomous_loop(
        root=tmp_path,
        task_plan=_plan(
            WorkItem("W001", "模块 A", "完成 A", target_files=["a.ts"]),
            WorkItem("W002", "模块 B", "完成 B", target_files=["b.ts"]),
        ),
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
    ):
        if event.kind == "result":
            result = event.result

    assert started == {"W001", "W002"}
    assert max_active == 2
    assert result is not None
    assert result.worklist["succeeded"] == 2
    assert result.worklist["scheduler"]["mode"] == "dependency_graph"


@pytest.mark.asyncio
async def test_same_target_file_runs_serially_in_priority_order(tmp_path, monkeypatch) -> None:
    """声明修改同一文件的 Work 不并行，且数字较小的 priority 先执行。"""

    monkeypatch.setenv("CODE_AGENT_PARALLEL_WORKERS", "4")
    order: list[str] = []
    active = 0
    max_active = 0

    async def fake_complete(**kwargs):
        """记录同文件 Work 的真实启动顺序与最大并发数。"""

        nonlocal active, max_active
        system = kwargs["messages"][0].content
        if "最终汇总器" in system:
            return (
                json.dumps({"action": "finish", "summary": "串行任务完成"}),
                LlmUsage(),
                SimpleNamespace(name="Final Model"),
            )
        work_id = _worker_id(system)
        active += 1
        max_active = max(max_active, active)
        order.append(work_id)
        await asyncio.sleep(0.01)
        active -= 1
        return (
            json.dumps(
                {"action": "complete_work", "workId": work_id, "summary": "完成"}
            ),
            LlmUsage(),
            SimpleNamespace(name="Worker Model"),
        )

    monkeypatch.setattr("backend.services.agent.loop.runner.GATEWAY.complete", fake_complete)
    async for _ in stream_autonomous_loop(
        root=tmp_path,
        task_plan=_plan(
            WorkItem(
                "W001",
                "后改共享文件",
                "后执行",
                priority=80,
                target_files=["src/shared.ts"],
            ),
            WorkItem(
                "W002",
                "先改共享文件",
                "先执行",
                priority=10,
                target_files=["src/shared.ts"],
            ),
        ),
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
    ):
        pass

    assert order == ["W002", "W001"]
    assert max_active == 1


@pytest.mark.asyncio
async def test_parallel_wave_replans_once_with_full_success_and_failure_json(
    tmp_path,
    monkeypatch,
) -> None:
    """一个并行 Work 失败时，Planner 一次收到整波成功与失败快照。"""

    monkeypatch.setenv("CODE_AGENT_PARALLEL_WORKERS", "4")
    worker_calls = {"W001": 0, "W002": 0}
    planner_payloads: list[dict[str, object]] = []

    async def fake_complete(**kwargs):
        """同时模拟 Worker、批量失败恢复 Planner 与最终汇总器。"""

        system = kwargs["messages"][0].content
        user = kwargs["messages"][-1].content
        if "失败恢复 Planner" in system:
            planner_payloads.append(json.loads(user))
            return (
                json.dumps(
                    {
                        "reason": "保留 W001，仅重试 W002",
                        "retry": [
                            {
                                "id": "W002",
                                "title": "修复模块 B",
                                "objective": "创建 b.py",
                                "acceptanceCriteria": ["b.py 存在"],
                                "dependencies": [],
                                "priority": 20,
                                "targetFiles": ["b.py"],
                            }
                        ],
                        "newWorks": [],
                        "skip": [],
                    }
                ),
                LlmUsage(prompt=3, completion=2, total=5),
                SimpleNamespace(name="Planner Model"),
            )
        if "最终汇总器" in system:
            return (
                json.dumps({"action": "finish", "summary": "全部完成"}),
                LlmUsage(),
                SimpleNamespace(name="Final Model"),
            )
        work_id = _worker_id(system)
        worker_calls[work_id] += 1
        if work_id == "W001":
            response = {
                "action": "complete_work",
                "workId": "W001",
                "summary": "A 已完成",
            }
        elif worker_calls[work_id] == 1:
            response = {
                "action": "edit",
                "workId": "W002",
                "summary": "触发真实失败",
                "operations": [
                    {
                        "type": "replace",
                        "path": "missing.py",
                        "oldText": "x",
                        "newText": "y",
                    }
                ],
            }
        elif worker_calls[work_id] == 2:
            response = {
                "action": "edit",
                "workId": "W002",
                "summary": "创建 B",
                "operations": [
                    {"type": "write", "path": "b.py", "content": "B = 2\n"}
                ],
            }
        else:
            response = {
                "action": "complete_work",
                "workId": "W002",
                "summary": "B 已完成",
            }
        return (
            json.dumps(response),
            LlmUsage(prompt=2, completion=1, total=3),
            SimpleNamespace(name="Worker Model"),
        )

    monkeypatch.setattr("backend.services.agent.loop.runner.GATEWAY.complete", fake_complete)
    result = None
    async for event in stream_autonomous_loop(
        root=tmp_path,
        task_plan=_plan(
            WorkItem("W001", "模块 A", "完成 A", target_files=["a.py"]),
            WorkItem("W002", "模块 B", "完成 B", target_files=["b.py"]),
        ),
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
    ):
        if event.kind == "result":
            result = event.result

    assert len(planner_payloads) == 1
    payload = planner_payloads[0]
    assert payload["failedWorkIds"] == ["W002"]
    snapshot = payload["fullWorkListSnapshot"]
    assert isinstance(snapshot, dict)
    assert snapshot["succeeded"] == 1
    assert snapshot["failed"] == 1
    assert result is not None
    assert result.worklist["succeeded"] == 2
    assert result.worklist["items"][0]["attempts"] == 1
    assert (tmp_path / "b.py").read_text("utf-8") == "B = 2\n"


@pytest.mark.asyncio
async def test_rolling_scheduler_starts_unlocked_work_before_slow_peer_finishes(
    tmp_path,
    monkeypatch,
) -> None:
    """一个 Work 完成后应立即启动其下游任务，而不是等待同批慢任务结束。"""

    monkeypatch.setenv("CODE_AGENT_PARALLEL_WORKERS", "2")
    downstream_started = asyncio.Event()
    slow_started = asyncio.Event()
    start_order: list[str] = []

    async def fake_complete(**kwargs):
        """让 W002 等待 W003 启动，以验证调度器不存在整波屏障。"""

        system = kwargs["messages"][0].content
        work_id = _worker_id(system)
        start_order.append(work_id)
        if work_id == "W001":
            await asyncio.sleep(0.02)
        elif work_id == "W002":
            slow_started.set()
            await asyncio.wait_for(downstream_started.wait(), timeout=1)
        elif work_id == "W003":
            downstream_started.set()
        return (
            json.dumps(
                {
                    "action": "complete_work",
                    "workId": work_id,
                    "summary": f"{work_id} 完成",
                }
            ),
            LlmUsage(prompt=2, completion=1, total=3),
            SimpleNamespace(name="Worker Model"),
        )

    monkeypatch.setattr("backend.services.agent.loop.runner.GATEWAY.complete", fake_complete)
    result = None
    async for event in stream_autonomous_loop(
        root=tmp_path,
        task_plan=_plan(
            WorkItem("W001", "基础契约", "完成契约", target_files=["types.ts"]),
            WorkItem("W002", "慢速模块", "完成慢速模块", target_files=["slow.ts"]),
            WorkItem(
                "W003",
                "下游模块",
                "依赖基础契约",
                dependencies=["W001"],
                target_files=["downstream.ts"],
            ),
        ),
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
    ):
        if event.kind == "result":
            result = event.result

    assert slow_started.is_set()
    assert downstream_started.is_set()
    assert start_order.index("W003") > start_order.index("W001")
    assert result is not None
    assert result.worklist["succeeded"] == 3


def test_directory_scope_does_not_serialize_exact_file_work() -> None:
    """宽泛目录只表示影响范围，不应把不同文件的 Work 全部串行化。"""

    works = [
        WorkItem("W001", "目录范围", "修改页面", target_files=["src/pages"]),
        WorkItem(
            "W002",
            "具体文件",
            "修改购物车",
            target_files=["src/store/cart.ts"],
        ),
    ]

    assert [item.id for item in select_parallel_wave(works, 4)] == ["W001", "W002"]
