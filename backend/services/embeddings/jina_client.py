"""Jina Search Foundation API 客户端。

托管 API 地址：
- Embedding：POST https://api.jina.ai/v1/embeddings
- Rerank：POST https://api.jina.ai/v1/rerank

两个接口共用同一个 API Key 与免费 Token 池。密钥优先使用请求级
``api_key``，其次使用环境变量 ``JINA_API_KEY``；本模块不会把密钥写入日志。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from backend.core.config import get_settings

LOGGER = logging.getLogger(__name__)

JINA_EMBEDDINGS_ENDPOINT = "https://api.jina.ai/v1/embeddings"
JINA_RERANK_ENDPOINT = "https://api.jina.ai/v1/rerank"

# 本地检索场景使用 Matryoshka 截断后的低维度，存储与计算开销更小。
DEFAULT_EMBEDDING_DIMENSIONS = 768


class JinaError(RuntimeError):
    """Jina API 配置缺失或请求失败时抛出的统一异常。"""


@dataclass(frozen=True, slots=True)
class JinaUsage:
    """保存一次 Jina 调用的 Token 用量，供免费额度监控。"""

    model: str
    operation: str
    prompt_tokens: int
    total_tokens: int


class JinaClient:
    """封装 Jina Embedding 与 Rerank 调用，支持批量、重试和用量统计。"""

    def __init__(
        self,
        api_key: str = "",
        *,
        embedding_model: str = "",
        rerank_model: str = "",
        timeout_seconds: float = 0.0,
        retries: int = 2,
        max_batch: int = 64,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """按参数与环境变量初始化客户端；未配置密钥时抛出可识别异常。"""

        settings = get_settings()
        self.api_key = api_key.strip() or settings.jina_api_key
        self.embedding_model = embedding_model.strip() or settings.jina_embedding_model
        self.rerank_model = rerank_model.strip() or settings.jina_rerank_model
        self.timeout_seconds = timeout_seconds or settings.jina_timeout_seconds
        self.retries = max(0, retries)
        self.max_batch = max(1, min(max_batch, 256))
        self._transport = transport
        if not self.api_key:
            raise JinaError(
                "未配置 Jina API Key，请设置 JINA_API_KEY 或在请求头传入 x-jina-api-key。"
            )

    async def embed_texts(
        self,
        texts: list[str],
        *,
        task: str = "retrieval.passage",
        dimensions: int = DEFAULT_EMBEDDING_DIMENSIONS,
    ) -> tuple[list[list[float]], JinaUsage]:
        """批量向量化文本，返回（向量列表, 用量）。

        ``task`` 默认使用 ``retrieval.passage``（索引文档侧）；查询侧请显式传入
        ``retrieval.query``。hosted API 只接受 retrieval.query / retrieval.passage /
        text-matching / clustering / classification，不接受单独的 retrieval。
        向量维度由 Matryoshka 截断控制。
        """

        normalized = [str(item).strip() for item in texts if str(item).strip()]
        if not normalized:
            return [], JinaUsage(self.embedding_model, "embed", 0, 0)

        vectors: list[list[float]] = []
        prompt_tokens = 0
        total_tokens = 0
        for start in range(0, len(normalized), self.max_batch):
            batch = normalized[start : start + self.max_batch]
            payload: dict[str, object] = {
                "model": self.embedding_model,
                "input": batch,
                "task": task,
                "dimensions": dimensions,
            }
            data = await self._post(JINA_EMBEDDINGS_ENDPOINT, payload)
            items = data.get("data") if isinstance(data, dict) else None
            if not isinstance(items, list):
                raise JinaError("Jina Embedding 响应缺少 data 字段。")
            ordered = sorted(items, key=lambda item: int(item.get("index") or 0))
            for item in ordered:
                embedding = item.get("embedding")
                if not isinstance(embedding, list):
                    raise JinaError("Jina Embedding 响应缺少向量值。")
                vectors.append([float(value) for value in embedding])
            usage = data.get("usage") if isinstance(data, dict) else {}
            if isinstance(usage, dict):
                prompt_tokens += int(usage.get("prompt_tokens") or 0)
                total_tokens += int(usage.get("total_tokens") or 0)

        return vectors, JinaUsage(self.embedding_model, "embed", prompt_tokens, total_tokens)

    async def embed_content(
        self,
        inputs: list[dict[str, Any]],
        *,
        task: str = "retrieval.passage",
        dimensions: int = DEFAULT_EMBEDDING_DIMENSIONS,
    ) -> tuple[list[list[float]], JinaUsage]:
        """向量化多模态输入（图片/音频/视频通过 content 块传入）。

        每个输入形如：``{"content": [{"type": "text", "text": "..."},
        {"type": "image", "format": "base64", "value": "..."}]}``。
        当前知识库索引以文本为主，该接口为后续图片知识预留。
        """

        if not inputs:
            return [], JinaUsage(self.embedding_model, "embed", 0, 0)
        vectors: list[list[float]] = []
        prompt_tokens = 0
        total_tokens = 0
        for start in range(0, len(inputs), self.max_batch):
            batch = inputs[start : start + self.max_batch]
            payload: dict[str, object] = {
                "model": self.embedding_model,
                "input": batch,
                "task": task,
                "dimensions": dimensions,
            }
            data = await self._post(JINA_EMBEDDINGS_ENDPOINT, payload)
            items = data.get("data") if isinstance(data, dict) else None
            if not isinstance(items, list):
                raise JinaError("Jina Embedding 响应缺少 data 字段。")
            ordered = sorted(items, key=lambda item: int(item.get("index") or 0))
            for item in ordered:
                embedding = item.get("embedding")
                if not isinstance(embedding, list):
                    raise JinaError("Jina Embedding 响应缺少向量值。")
                vectors.append([float(value) for value in embedding])
            usage = data.get("usage") if isinstance(data, dict) else {}
            if isinstance(usage, dict):
                prompt_tokens += int(usage.get("prompt_tokens") or 0)
                total_tokens += int(usage.get("total_tokens") or 0)
        return vectors, JinaUsage(self.embedding_model, "embed", prompt_tokens, total_tokens)

    async def rerank(
        self,
        query: str,
        documents: list[str],
        *,
        top_n: int = 5,
    ) -> list[dict[str, Any]]:
        """对候选文档精排，返回按相关性降序的结果列表。"""

        normalized = [str(item).strip() for item in documents if str(item).strip()]
        if not normalized:
            return []
        payload: dict[str, object] = {
            "model": self.rerank_model,
            "query": str(query).strip(),
            "documents": normalized,
            "top_n": max(1, min(top_n, len(normalized))),
        }
        data = await self._post(JINA_RERANK_ENDPOINT, payload)
        results = data.get("results") if isinstance(data, dict) else None
        if not isinstance(results, list):
            raise JinaError("Jina Rerank 响应缺少 results 字段。")
        return [
            {
                "index": int(item.get("index") or 0),
                "score": float(item.get("relevance_score") or 0.0),
                "document": str(item.get("document") or ""),
            }
            for item in results
        ]

    async def _post(self, endpoint: str, payload: dict[str, object]) -> dict[str, Any]:
        """带重试与退避地调用 Jina API，并统一抛出可读错误。"""

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": "multi-agent-backend/1.0",
        }
        last_error: Exception | None = None
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(self.timeout_seconds),
            transport=self._transport,
        ) as client:
            for attempt in range(self.retries + 1):
                try:
                    response = await client.post(endpoint, headers=headers, json=payload)
                except (httpx.TimeoutException, httpx.NetworkError) as exc:
                    last_error = exc
                    if attempt >= self.retries:
                        raise JinaError(f"连接 Jina API 失败：{exc}") from exc
                    await asyncio.sleep(min(2**attempt, 4))
                    continue
                if response.status_code < 400:
                    try:
                        return response.json()
                    except ValueError as exc:
                        raise JinaError("Jina API 返回了非 JSON 响应。") from exc
                message = self._extract_error(response)
                if (
                    response.status_code in {408, 409, 429, 500, 502, 503, 504}
                    and attempt < self.retries
                ):
                    await asyncio.sleep(min(2**attempt, 4))
                    last_error = JinaError(
                        f"Jina API 请求失败（HTTP {response.status_code}）：{message}"
                    )
                    continue
                raise JinaError(f"Jina API 请求失败（HTTP {response.status_code}）：{message}")
        raise JinaError(f"Jina API 请求失败：{last_error or '未知错误'}")

    @staticmethod
    def _extract_error(response: httpx.Response) -> str:
        """从错误响应中提取人类可读信息，不暴露密钥。"""

        try:
            data = response.json()
        except ValueError:
            return response.text[:500] or response.reason_phrase
        if isinstance(data, dict):
            error = data.get("error")
            if isinstance(error, dict):
                return str(error.get("message") or error.get("code") or error)
            return str(data.get("message") or data.get("detail") or data)
        return str(data)[:500]
