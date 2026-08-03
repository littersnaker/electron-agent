"""Media Agent 注册、媒体 schema 与 ffmpeg 探测测试。"""

from pathlib import Path

import pytest

from backend.runtime.agent_registry import AgentRegistry
from backend.schemas.media import MediaGenerateBody
from backend.services.media.video_merge import merge_videos, resolve_ffmpeg


def test_media_agent_registered_in_registry(tmp_path: Path) -> None:
    """Media Agent 配置应能被注册表加载，且使用批准的白名单适配器。"""

    config_root = Path(__file__).resolve().parents[2] / "agents"
    registry = AgentRegistry(config_root)
    registry.load()
    ids = [item["id"] for item in registry.catalog()]
    assert "media" in ids
    registered = registry.get("media")
    assert registered is not None
    assert registered.config.adapter == "media_agent"
    assert registered.adapter.agent_id == "media"


def test_media_body_accepts_seed_and_negative_prompt() -> None:
    """seed 与 negativePrompt 应能透传进生成请求。"""

    body = MediaGenerateBody(
        model_id="qwen:qwen-image-2.0-pro",
        mode="text-to-image",
        prompt="少年与机械猫",
        seed=1234,
        negativePrompt="3D 渲染，塑料质感",
    )
    assert body.seed == 1234
    assert body.negative_prompt == "3D 渲染，塑料质感"


def test_ffmpeg_resolves_via_imageio() -> None:
    """系统没有 ffmpeg 时应回退到 imageio-ffmpeg 自带二进制。"""

    assert resolve_ffmpeg() is not None


@pytest.mark.asyncio
async def test_merge_videos_rejects_empty_input() -> None:
    """没有可合并视频时应抛错而不是生成空文件。"""

    with pytest.raises(ValueError):
        await merge_videos([], "out.mp4")
