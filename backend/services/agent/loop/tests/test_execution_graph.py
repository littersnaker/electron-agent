"""执行图派生测试：trace 事件 → 节点 + 顺序边。"""

from __future__ import annotations

from backend.services.agent.loop.trace import build_execution_graph


def test_build_execution_graph_produces_nodes_and_edges() -> None:
    """按 sequence 顺序生成节点与边，节点携带状态/耗时/详情。"""

    events = [
        {
            "id": "e1",
            "sequence": 1,
            "category": "stage",
            "name": "STATUS",
            "status": "running",
            "durationMs": 10,
            "metadata": {"detail": "预处理"},
        },
        {
            "id": "e2",
            "sequence": 2,
            "category": "tool",
            "name": "TOOL_STATUS",
            "status": "running",
            "durationMs": 30,
            "metadata": {"detail": "执行工具"},
        },
    ]
    graph = build_execution_graph(events)
    assert [node["id"] for node in graph["nodes"]] == ["e1", "e2"]
    assert graph["nodes"][1]["category"] == "tool"
    assert graph["edges"] == [{"source": "e1", "target": "e2"}]


def test_build_execution_graph_empty() -> None:
    """无事件时返回空图，前端可安全渲染。"""

    graph = build_execution_graph([])
    assert graph == {"nodes": [], "edges": []}
