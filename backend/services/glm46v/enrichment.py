"""在 Code/QA Agent 进入原有工作流前注入 GLM 视觉分析结果。"""

from __future__ import annotations

import logging
import os
from dataclasses import replace
from typing import Any

import httpx

from backend.runtime.contracts import RuntimeContext, RuntimeRequest
from backend.services.glm46v.client import (
    GLM46VClient,
    GLM46VError,
    GLM46VSettings,
    ImageInput,
    normalize_image_data,
)
from backend.services.glm46v.skill import GLM46V_SKILL_ID

LOGGER = logging.getLogger(__name__)
RESULT_HEADER = "## Skill Tool Result · glm46v-vision"
MAX_RESULT_CHARACTERS = 16_000


def _enabled() -> bool:
    return os.getenv("GLM46V_VISION_ENABLED", "1").strip().lower() not in {
        "0",
        "false",
        "off",
        "no",
    }


def _attachment_value(attachment: object, *names: str) -> str:
    for name in names:
        value = getattr(attachment, name, None)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _is_image_attachment(attachment: object) -> bool:
    mime_type = _attachment_value(attachment, "mime_type", "mimeType", "type")
    return mime_type.lower().startswith("image/")


def _image_attachments(payload: object) -> list[object]:
    attachments = getattr(payload, "attachments", None)
    if not isinstance(attachments, list):
        return []
    return [attachment for attachment in attachments if _is_image_attachment(attachment)]


def has_image_attachments(payload: object) -> bool:
    """判断请求体是否含图片，不受 GLM 开关影响。"""

    return bool(_image_attachments(payload))


def has_glm46v_image_work(request: RuntimeRequest) -> bool:
    """判断当前请求是否包含可交给 GLM 的图片附件。"""

    return _enabled() and has_image_attachments(request.payload)


def strip_image_attachments(payload: object) -> object:
    """复制请求体并移除图片附件，避免文本模型再次收到原始图片。

    GLM 已完成图片理解后，下游 DeepSeek 等纯文本模型只需要读取 Runtime Context
    中的视觉证据。保留非图片附件，避免影响未来扩展。
    """

    attachments = getattr(payload, "attachments", None)
    if not isinstance(attachments, list):
        return payload
    remaining = [item for item in attachments if not _is_image_attachment(item)]

    model_copy = getattr(payload, "model_copy", None)
    if callable(model_copy):
        return model_copy(update={"attachments": remaining})

    legacy_copy = getattr(payload, "copy", None)
    if callable(legacy_copy):
        try:
            return legacy_copy(update={"attachments": remaining})
        except TypeError:
            pass

    # 实际运行对象是 Pydantic ChatRequest，正常会走 model_copy。这里仅兼容测试替身。
    try:
        setattr(payload, "attachments", remaining)
    except (AttributeError, TypeError):
        return payload
    return payload


def _normalize_images(
    attachments: list[object],
    settings: GLM46VSettings,
) -> list[ImageInput]:
    images: list[ImageInput] = []
    for attachment in attachments[: settings.max_images]:
        name = _attachment_value(attachment, "name") or "attachment"
        mime_type = _attachment_value(
            attachment,
            "mime_type",
            "mimeType",
            "type",
        ) or "image/png"
        data = _attachment_value(attachment, "data_url", "dataUrl", "data")
        if not data:
            continue
        images.append(
            normalize_image_data(
                name=name,
                mime_type=mime_type,
                data=data,
                max_image_mb=settings.max_image_mb,
            )
        )
    return images


def _analysis_prompt(*, agent_id: str, user_text: str, images: list[ImageInput]) -> str:
    image_names = "、".join(item.name for item in images)
    common = f"""你是 GLM-4.6V-Flash 视觉证据分析子代理。当前主 Agent={agent_id}。
用户当前任务：
{user_text.strip() or '请分析上传图片'}

图片：{image_names}

必须遵守：
- 只报告图中可见或可由图中证据直接支持的信息；不确定内容明确标注。
- OCR 尽量保持原文、大小写、数字、顺序和层级；模糊字符使用【不确定】标记。
- 多图时先标注每张图，再总结共同点、差异和相互关系。
- 输出结构化中文结论，不输出思维过程，不讨论 API Key。
"""
    if agent_id == "coding":
        return common + """
为后续代码实现额外提取：
1. 页面/画面的层级、主要区域、组件与相对位置；
2. 可见文字、字体视觉特征、字号层级、颜色、间距、圆角、边框和阴影；
3. 交互状态、响应式线索、重复组件和可复用设计令牌；
4. 对实现影响最大的约束，以及需要主 Agent 再从项目代码中验证的事项。
不要生成完整代码，只输出可供 Code Agent 落地的视觉规格和证据。
"""
    return common + """
为后续问答额外提取：
1. 与用户问题直接相关的视觉事实和 OCR；
2. 表格、图表、对象关系、数量、位置和异常点；
3. “直接可见事实 / 合理推断 / 无法确认”三类结论。
不要脱离图片证据扩写背景知识。
"""


def _render_result(
    *,
    result: dict[str, Any],
    images: list[ImageInput],
) -> str:
    content = str(result.get("content") or "").strip()[:MAX_RESULT_CHARACTERS]
    names = "、".join(item.name for item in images)
    return (
        f"{RESULT_HEADER}\n"
        f"模型：{result.get('model') or 'glm-4.6v-flash'}\n"
        f"图片：{names}\n"
        "说明：以下是视觉辅助证据，必须与原附件和项目真实文件交叉验证。\n\n"
        f"{content}"
    )


def _strict_error(message: str, *, cause: Exception | None = None) -> GLM46VError:
    error = GLM46VError(message)
    if cause is not None:
        error.__cause__ = cause
    return error


async def enrich_runtime_context_with_glm46v(
    *,
    request: RuntimeRequest,
    context: RuntimeContext,
    agent_id: str,
    client: GLM46VClient | None = None,
    strict: bool = False,
) -> RuntimeContext:
    """有图片时调用 GLM，并把结果追加到统一 Runtime Context。

    ``strict=True`` 用于 Code/QA 的图片入口：GLM 失败时明确中止，不能再把图片交给
    DeepSeek 等纯文本模型。``strict=False`` 保留旧的辅助能力降级语义。
    """

    if RESULT_HEADER in context.rendered:
        return context

    attachments = _image_attachments(request.payload)
    if not attachments:
        return context

    if not _enabled():
        if strict:
            raise GLM46VError(
                "GLM-4.6V 视觉 Skill 已被 GLM46V_VISION_ENABLED 配置关闭。"
            )
        return context

    settings = client.settings if client is not None else GLM46VSettings.from_credentials(
        request.credentials
    )
    if not settings.api_key:
        if strict:
            raise GLM46VError(
                "未读取到智谱 GLM API Key。请确认客户端“智谱 GLM”配置已保存，"
                "并重启后端后重试。"
            )
        return context

    try:
        images = _normalize_images(attachments, settings)
        if not images:
            raise GLM46VError("图片附件没有可用的 Base64 数据。")
        active_client = client or GLM46VClient(settings)
        result = await active_client.analyze_images(
            images,
            prompt=_analysis_prompt(
                agent_id=agent_id,
                user_text=request.user_text,
                images=images,
            ),
        )
    except (GLM46VError, httpx.HTTPError, OSError, ValueError) as exc:
        LOGGER.warning("GLM-4.6V 视觉分析失败：%s", exc)
        if strict:
            if isinstance(exc, GLM46VError):
                raise
            raise _strict_error(f"GLM-4.6V 视觉分析失败：{exc}", cause=exc)
        return context
    except Exception as exc:  # noqa: BLE001 - 辅助能力需兼容未知 SDK/网络错误
        LOGGER.warning("GLM-4.6V 视觉分析出现未预期错误：%s", exc)
        if strict:
            raise _strict_error(f"GLM-4.6V 视觉分析出现未预期错误：{exc}", cause=exc)
        return context

    block = _render_result(result=result, images=images)
    rendered = f"{context.rendered.rstrip()}\n\n{block}" if context.rendered.strip() else block
    estimated_extra = max(1, (len(block) + 1) // 2)
    metadata = dict(context.metadata)
    metadata["glm46vVision"] = {
        "attempted": True,
        "used": True,
        "model": result.get("model") or settings.model,
        "imageCount": len(images),
        "imageNames": [item.name for item in images],
        "usage": result.get("usage") or {},
        "downstreamAttachmentPolicy": "strip-images-after-glm",
    }
    return replace(
        context,
        rendered=rendered,
        estimated_tokens=min(
            context.token_budget,
            context.estimated_tokens + estimated_extra,
        ),
        skill_ids=tuple(dict.fromkeys((*context.skill_ids, GLM46V_SKILL_ID))),
        metadata=metadata,
    )
