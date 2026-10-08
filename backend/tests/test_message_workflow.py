"""工作流程随消息写入会话 JSON，旧消息及重新打开后的读取兼容。"""

from __future__ import annotations

import asyncio

from backend.core.config import get_settings
from backend.schemas.common import StoredMessage
from backend.services.workspace.database import initialize_database
from backend.services.workspace.repository import create_session, list_workspace, update_session


def test_workflow_roundtrip_preserves_history_and_legacy_messages(tmp_path, monkeypatch) -> None:
    """通过现有会话仓储保存两轮流程，再用新事件循环从 SQLite 读取。"""
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()

    async def write():
        await initialize_database()
        session = await create_session(mode="qa", project_id=None, title="历史", messages=[])
        snapshots = [
            {
                "id": "run1",
                "mode": "code",
                "status": "completed",
                "startedAt": 1000,
                "updatedAt": 2000,
                "endedAt": 2000,
                "detail": "修改完成",
                "toolActivities": [
                    {
                        "id": "tool1",
                        "label": "读取文件",
                        "status": "completed",
                        "startedAt": 1000,
                        "endedAt": 2000,
                    }
                ],
                "lifecycleEvents": [],
            },
            {
                "id": "run2",
                "mode": "media",
                "status": "waiting",
                "startedAt": 3000,
                "updatedAt": 4000,
                "detail": "请确认分镜",
                "toolActivities": [],
                "lifecycleEvents": [
                    {"id": "event1", "role": "media_agent", "detail": "命中角色库"}
                ],
            },
        ]
        messages = [StoredMessage(role="assistant", content="旧会话，不含流程")]
        messages.extend(
            StoredMessage(role="assistant", content="回复", workflow=snapshot)
            for snapshot in snapshots
        )
        await update_session(session_id=session.id, title=session.title, messages=messages)
        return snapshots

    try:
        snapshots = asyncio.run(write())
        workspace = asyncio.run(
            list_workspace(
                include_code=True, include_commerce=True, include_media=True, include_image=True
            )
        )
        messages = workspace.sessions[0].messages
        assert messages[0].workflow is None
        assert [message.workflow for message in messages[1:]] == snapshots
    finally:
        get_settings.cache_clear()


def test_media_terminal_events_reflect_failure_and_cancel(monkeypatch) -> None:
    """媒体异常、拒绝确认及失败分镜均上报真实终态，不再一律 completed。"""
    import json

    from backend.schemas.chat import ChatRequest
    from backend.services.llm.credentials import LlmCredentials
    from backend.services.media import agent_service

    async def fail_direct(**kwargs):
        raise ValueError("provider failed")
        yield ""  # 保持异步生成器接口。

    async def empty_action(request_id):
        return None

    monkeypatch.setattr(agent_service, "_stream_direct_media", fail_direct)
    monkeypatch.setattr(agent_service, "pop_pending_action", empty_action)

    async def collect(prompt):
        body = ChatRequest(messages=[{"role": "user", "content": prompt}])
        frames = [
            frame
            async for frame in agent_service.stream_media_agent(
                body=body, credentials=LlmCredentials(values={}), preferred_model_id="auto"
            )
        ]
        return [
            json.loads(line[5:].strip())
            for frame in frames
            for line in frame.splitlines()
            if line.startswith("data:")
        ]

    failed = asyncio.run(collect("生成一张图片"))
    assert any(packet.get("payload", {}).get("status") == "FAILED" for packet in failed)
    canceled = asyncio.run(collect("[INTERACTIVE_REPLY] id=test mode=user answer=reject"))
    assert any(packet.get("payload", {}).get("status") == "CANCELED" for packet in canceled)

    async def action(request_id):
        return {"kind": "comic_storyboard", "storyboard": [], "characters": [], "outputDir": ""}

    async def drain(graph, initial, queue, state_holder):
        state_holder.append(
            {"report": {"passed": False, "shotFailed": 1, "reason": "视频生成失败"}}
        )
        if False:
            yield ""

    monkeypatch.setattr(agent_service, "pop_pending_action", action)
    monkeypatch.setattr(agent_service, "build_comic_pipeline", lambda **kwargs: object())
    monkeypatch.setattr(agent_service, "_drain_graph", drain)
    packets = asyncio.run(collect("[INTERACTIVE_REPLY] id=test mode=user answer=approve"))
    terminal = [packet["payload"] for packet in packets if packet.get("type") == "AGENT_LIFECYCLE"]
    assert terminal[-1]["status"] == "FAILED"
    assert terminal[-1]["detail"] == "视频生成失败"
