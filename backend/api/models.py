"""公开模型目录、供应商状态与连接验证接口。"""

from __future__ import annotations

from time import perf_counter
from typing import cast

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from backend.services.llm.catalog import (
    MODELS,
    ModelDefinition,
    ProviderId,
    auto_models_for_provider,
    get_model,
)
from backend.schemas.custom_models import CustomModelInput
from backend.services.llm.credentials import public_provider_status, resolve_credentials
from backend.services.llm.custom_models import (
    create_custom_model,
    delete_custom_model,
    get_custom_model_definition,
    list_custom_models,
    update_custom_model,
)
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.protocols import ProviderRequestError
from backend.services.media.catalog import MEDIA_MODELS

router = APIRouter(tags=["models"])


class ModelProbeRequest(BaseModel):
    """模型连接验证请求。"""

    model_id: str | None = Field(default=None, alias="modelId")
    provider: str | None = None


def _model_payload() -> list[dict[str, object]]:
    """把 Python 模型注册表转换成与前端兼容的 JSON。"""

    return [
        {
            "id": model.id,
            "provider": model.provider,
            "model": model.model,
            "name": model.name,
            "description": model.description,
            "capabilities": list(model.capabilities),
            "chatCompatible": model.chat_compatible,
            "autoSelect": model.auto_select,
            "fallbackSelect": model.fallback_select,
            "autoPriority": model.auto_priority,
        }
        for model in MODELS
    ]


def _resolve_probe_models(body: ModelProbeRequest) -> tuple[ModelDefinition, ...]:
    """解析验证候选。明确模型只测一个；供应商验证可尝试多个通用模型。"""

    if body.model_id:
        model = get_custom_model_definition(body.model_id) or get_model(body.model_id)
        if not model:
            raise ValueError(f"未识别的模型：{body.model_id}")
        return (model,)

    provider_id = (body.provider or "").strip()
    allowed = {model.provider for model in MODELS}
    if provider_id not in allowed:
        raise ValueError(f"未识别的模型供应商：{provider_id or '空'}")
    provider = cast(ProviderId, provider_id)
    return auto_models_for_provider(provider)


def _probe_guidance(provider: str | None, exc: Exception) -> str:
    """针对常见供应商错误补充不含敏感信息的中文排查建议。"""

    if not isinstance(exc, ProviderRequestError):
        return ""
    status_code = exc.status_code
    if provider == "kimi" and status_code in {401, 403}:
        return (
            "请确认 API Key 来自 platform.kimi.com，而不是 platform.kimi.ai；"
            "两个平台的 Key 不能混用。"
        )
    if provider == "kimi" and status_code == 404:
        return (
            "请在 Kimi 控制台确认账号等级已开放该模型，并通过 /v1/models "
            "核对当前 Key 可见的模型 ID。"
        )
    if provider == "qwen" and status_code in {401, 403, 404}:
        return (
            "百炼 Key 与模型通常绑定地域或业务空间。请从百炼控制台复制当前"
            "业务空间的 API Host，并在打包前通过 DASHSCOPE_BASE_URL 配置；"
            "模型级 404 会自动继续尝试 Plus、Flash 和已登记的百炼后备模型。"
        )
    if provider == "qwen" and status_code is None:
        return (
            "这是网络或 API Host 连接问题，不是 Max 模型不兼容。请检查百炼业务"
            "空间专属域名、DNS、防火墙、HTTPS 代理和系统时间。"
        )
    if status_code == 429:
        return "请检查账户余额、并发限制、速率限制和模型调用额度。"
    return ""


def _probe_failure_state(exc: Exception) -> str:
    """把供应商错误转换成设置界面可识别的连接状态。"""

    message = str(exc)
    if "未配置" in message or "没有可用 API Key" in message:
        return "unconfigured"
    if isinstance(exc, ProviderRequestError):
        if exc.status_code in {401, 403}:
            return "unauthorized"
        if exc.status_code == 429:
            return "quota_exceeded"
        if exc.status_code is None:
            return "network_error"
    return "error"


@router.get("/api/config")
async def get_public_config() -> dict[str, object]:
    """返回供应商配置状态和文本模型目录，不返回任何密钥。"""

    return {"providers": public_provider_status(), "models": _model_payload()}


@router.get("/api/models")
async def get_models() -> dict[str, object]:
    """返回文本模型和媒体模型目录。"""

    return {
        "providers": public_provider_status(),
        "models": _model_payload(),
        "mediaModels": MEDIA_MODELS,
    }


@router.post("/api/models/probe")
async def probe_model(
    body: ModelProbeRequest,
    request: Request,
) -> dict[str, object]:
    """用极短真实请求验证 API Key、端点和模型名称。"""

    started = perf_counter()
    model = None
    last_error: Exception | None = None
    try:
        candidates = _resolve_probe_models(body)
        credentials = resolve_credentials(request)
        for model in candidates:
            try:
                await GATEWAY.probe(model_id=model.id, credentials=credentials)
                latency_ms = round((perf_counter() - started) * 1000)
                credential_source = credentials.source(model.provider)
                source_note = (
                    "（正在使用应用内置百炼兜底）"
                    if credential_source == "builtin"
                    else ""
                )
                return {
                    "ok": True,
                    "state": "connected",
                    "message": f"{model.name} 连接正常{source_note}。",
                    "modelId": model.id,
                    "model": model.model,
                    "provider": model.provider,
                    "credentialSource": credential_source,
                    "latencyMs": latency_ms,
                }
            except ProviderRequestError as exc:
                last_error = exc
                # 只有模型级错误才继续向下验证；网络/鉴权错误会影响同一端点下
                # 的全部模型，继续试 Max/Plus/Flash 只会重复失败。
                if exc.scope != "model" or body.model_id:
                    raise
        if last_error:
            raise last_error
        raise ValueError("该供应商没有可用于连接验证的通用模型。")
    except Exception as exc:
        latency_ms = round((perf_counter() - started) * 1000)
        provider = model.provider if model else (body.provider or None)
        guidance = _probe_guidance(provider, exc)
        message = str(exc)
        if guidance:
            message = f"{message} {guidance}"
        return {
            "ok": False,
            "state": _probe_failure_state(exc),
            "message": message,
            "latencyMs": latency_ms,
        }


@router.get("/api/models/custom")
async def get_custom_models() -> dict[str, object]:
    """返回 SQLite 中保存的用户自定义模型。"""

    return {"models": await list_custom_models()}


@router.post("/api/models/custom", status_code=201)
async def post_custom_model(body: CustomModelInput) -> dict[str, object]:
    """新增一个自定义模型；用户填写的 model 值会原样保存和发送。"""

    return {"model": await create_custom_model(body)}


@router.put("/api/models/custom/{model_id}")
async def put_custom_model(
    model_id: str,
    body: CustomModelInput,
) -> dict[str, object]:
    """修改自定义模型，但不改变其稳定 ID。"""

    updated = await update_custom_model(model_id, body)
    if not updated:
        raise HTTPException(status_code=404, detail="自定义模型不存在")
    return {"model": updated}


@router.delete("/api/models/custom/{model_id}", status_code=204)
async def remove_custom_model(model_id: str) -> Response:
    """删除自定义模型；删除后下次请求立即停止使用。"""

    if not await delete_custom_model(model_id):
        raise HTTPException(status_code=404, detail="自定义模型不存在")
    return Response(status_code=204)


@router.get("/api/models/endpoints")
async def get_model_endpoints() -> dict[str, object]:
    """返回可公开查看的请求地址说明，帮助确认 Base URL 应填写在哪一层。"""

    return {
        "local": {
            "customModels": {
                "list": "GET /api/models/custom",
                "create": "POST /api/models/custom",
                "update": "PUT /api/models/custom/{model_id}",
                "delete": "DELETE /api/models/custom/{model_id}",
            },
            "chat": ["POST /api/qa", "POST /api/chat"],
            "media": "POST /api/media/generate",
        },
        "chat": {
            "path": "/chat/completions",
            "qwenExampleBaseUrl": (
                "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
            ),
            "note": "聊天 Base URL 可填到 /v1，后端会自动补 /chat/completions。",
        },
        "image": {
            "path": "/api/v1/services/aigc/multimodal-generation/generation",
            "note": "图片使用媒体 API 根域名，不使用 /compatible-mode/v1。",
        },
        "video": {
            "submitPath": "/api/v1/services/aigc/video-generation/video-synthesis",
            "taskPath": "/api/v1/tasks/{task_id}",
            "uploadPath": "/api/v1/uploads",
            "note": "视频提交、轮询和上传必须使用同一地域、同一业务空间域名。",
        },
    }
