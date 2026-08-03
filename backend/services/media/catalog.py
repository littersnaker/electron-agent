"""媒体模型注册表。"""

from __future__ import annotations

MEDIA_MODELS: list[dict[str, object]] = [
    {
        "id": "qwen:qwen-image-2.0-pro",
        "provider": "qwen",
        "model": "qwen-image-2.0-pro-2026-06-22",
        "name": "Qwen-Image 2.0 Pro",
        "description": "千问图像生成与编辑 Pro。",
        "modes": ["text-to-image", "image-edit"],
        "outputKind": "image",
        "protocol": "qwen-image-sync",
    },
    {
        "id": "qwen:qwen-image-2.0",
        "provider": "qwen",
        "model": "qwen-image-2.0",
        "name": "Qwen-Image 2.0",
        "description": "速度更快的图片生成与编辑模型。",
        "modes": ["text-to-image", "image-edit"],
        "outputKind": "image",
        "protocol": "qwen-image-sync",
    },
    {
        "id": "qwen:wan2.7-t2v-2026-06-12",
        "provider": "qwen",
        "model": "wan2.7-t2v-2026-06-12",
        "name": "Wan 2.7 文生视频 2026-06-12",
        "description": "Wan 文生视频模型。",
        "modes": ["text-to-video"],
        "outputKind": "video",
        "protocol": "dashscope-video-async",
    },
    {
        "id": "qwen:wan2.7-t2v-2026-04-25",
        "provider": "qwen",
        "model": "wan2.7-t2v-2026-04-25",
        "name": "Wan 2.7 文生视频 2026-04-25",
        "description": "Wan 文生视频快照模型。",
        "modes": ["text-to-video"],
        "outputKind": "video",
        "protocol": "dashscope-video-async",
    },
    {
        "id": "qwen:happyhorse-1.1-t2v",
        "provider": "qwen",
        "model": "happyhorse-1.1-t2v",
        "name": "HappyHorse 1.1 文生视频",
        "description": "HappyHorse 有声文生视频模型。",
        "modes": ["text-to-video"],
        "outputKind": "video",
        "protocol": "dashscope-video-async",
    },
    {
        "id": "qwen:wan2.7-i2v-2026-04-25",
        "provider": "qwen",
        "model": "wan2.7-i2v-2026-04-25",
        "name": "Wan 2.7 图生视频",
        "description": "首帧图生视频模型。",
        "modes": ["image-to-video"],
        "outputKind": "video",
        "protocol": "dashscope-video-async",
    },
    {
        "id": "qwen:happyhorse-1.1-i2v",
        "provider": "qwen",
        "model": "happyhorse-1.1-i2v",
        "name": "HappyHorse 1.1 图生视频",
        "description": "首帧图生视频模型。",
        "modes": ["image-to-video"],
        "outputKind": "video",
        "protocol": "dashscope-video-async",
    },
    {
        "id": "qwen:happyhorse-1.1-r2v",
        "provider": "qwen",
        "model": "happyhorse-1.1-r2v",
        "name": "HappyHorse 1.1 参考生视频",
        "description": "参考图片生成视频模型。",
        "modes": ["reference-to-video"],
        "outputKind": "video",
        "protocol": "dashscope-video-async",
    },
    {
        "id": "qwen:wan2.7-r2v-2026-06-12",
        "provider": "qwen",
        "model": "wan2.7-r2v-2026-06-12",
        "name": "Wan 2.7 参考生视频",
        "description": "Wan 多模态参考生视频模型。",
        "modes": ["reference-to-video"],
        "outputKind": "video",
        "protocol": "dashscope-video-async",
    },
    {
        "id": "qwen:happyhorse-1.0-video-edit",
        "provider": "qwen",
        "model": "happyhorse-1.0-video-edit",
        "name": "HappyHorse 1.0 视频编辑",
        "description": "视频风格转换与局部编辑模型。",
        "modes": ["video-edit"],
        "outputKind": "video",
        "protocol": "dashscope-video-async",
    },
]


def get_media_model(model_id: str) -> dict[str, object]:
    """按前端媒体模型 ID 返回注册信息。"""

    for model in MEDIA_MODELS:
        if model["id"] == model_id:
            return model
    raise ValueError(f"未注册的媒体模型：{model_id}")
