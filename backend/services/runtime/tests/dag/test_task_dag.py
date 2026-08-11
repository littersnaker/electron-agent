"""Task DAG 的依赖、重试和回滚测试。"""

from __future__ import annotations

import asyncio

import pytest

from backend.services.runtime.dag import TaskDagExecutionError, TaskDagExecutor, TaskDagNode


@pytest.mark.asyncio
async def test_task_dag_executes_dependencies_and_retries() -> None:
    """节点应读取依赖结果，并在暂时失败后按限制重试。"""

    attempts = 0

    async def first(_: dict[str, object]) -> int:
        """返回基础结果。"""

        return 2

    async def second(dependencies: dict[str, object]) -> int:
        """第一次失败，第二次使用依赖结果成功。"""

        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("temporary")
        return int(dependencies["first"]) * 3

    result = await TaskDagExecutor(maximum_concurrency=2).execute(
        [
            TaskDagNode(id="first", handler=first),
            TaskDagNode(
                id="second",
                handler=second,
                dependencies=("first",),
                maximum_retries=1,
            ),
        ]
    )

    assert result.results == {"first": 2, "second": 6}
    assert result.attempts["second"] == 2
    assert result.completion_order == ("first", "second")


@pytest.mark.asyncio
async def test_task_dag_rolls_back_completed_nodes_after_failure() -> None:
    """后续节点失败时，应反向回滚已经完成且声明回滚函数的节点。"""

    rolled_back: list[str] = []

    async def successful(_: dict[str, object]) -> str:
        """模拟已经产生副作用的成功节点。"""

        return "created"

    async def rollback(value: object) -> None:
        """记录被回滚的结果。"""

        rolled_back.append(str(value))

    async def failing(_: dict[str, object]) -> None:
        """模拟不可恢复的后续失败。"""

        await asyncio.sleep(0)
        raise RuntimeError("boom")

    with pytest.raises(TaskDagExecutionError) as error:
        await TaskDagExecutor().execute(
            [
                TaskDagNode(id="create", handler=successful, rollback=rollback),
                TaskDagNode(id="fail", handler=failing, dependencies=("create",)),
            ]
        )

    assert error.value.node_id == "fail"
    assert rolled_back == ["created"]


def test_task_dag_rejects_cycle() -> None:
    """静态循环依赖必须在任何节点执行前被拒绝。"""

    async def noop(_: dict[str, object]) -> None:
        """测试用空节点。"""

        return None

    with pytest.raises(ValueError, match="循环依赖"):
        asyncio.run(
            TaskDagExecutor().execute(
                [
                    TaskDagNode(id="a", handler=noop, dependencies=("b",)),
                    TaskDagNode(id="b", handler=noop, dependencies=("a",)),
                ]
            )
        )
