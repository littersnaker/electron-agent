"""Auto Router 的轻量可用性缓存。

缓存只保存不可逆凭证指纹、模型 ID 和时间戳，不保存 API Key、提示词或回复内容。
它的目的不是替代真实请求，而是让首次请求发现可用模型后，后续请求优先复用；
同时短时间跳过已明确返回“模型不存在/未开通”的候选，减少无意义重试。
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

from backend.services.llm.catalog import ModelDefinition, ProviderId
from backend.services.llm.credentials import LlmCredentials

SUCCESS_TTL_SECONDS = 30 * 60
MODEL_FAILURE_TTL_SECONDS = 5 * 60
PROVIDER_FAILURE_TTL_SECONDS = 30


@dataclass(frozen=True, slots=True)
class CacheEntry:
    """记录一次成功或失败状态及其过期时间。"""

    expires_at: float
    scope: str


class ModelAvailabilityCache:
    """按“凭证指纹 + 模型”维护当前进程内的短期健康状态。"""

    def __init__(self) -> None:
        """初始化空缓存。"""

        self._success: dict[tuple[ProviderId, str], tuple[str, float]] = {}
        self._model_failures: dict[tuple[ProviderId, str, str], CacheEntry] = {}
        self._provider_failures: dict[tuple[ProviderId, str], CacheEntry] = {}

    def order_candidates(
        self,
        candidates: tuple[ModelDefinition, ...],
        credentials: LlmCredentials,
    ) -> tuple[ModelDefinition, ...]:
        """把最近成功模型提前，并暂时跳过已确认不可用的模型。

        若所有候选都处于短期失败缓存中，则仍返回原始候选，避免缓存造成永久锁死。
        """

        now = time.monotonic()
        visible = [
            model
            for model in candidates
            if not self._model_blocked(model, credentials, now)
            and not self.provider_blocked(model.provider, credentials, now)
        ]
        pool = visible or list(candidates)

        def sort_key(model: ModelDefinition) -> tuple[int, int]:
            """把近期成功状态转换成稳定排序键。"""

            fingerprint = self._fingerprint(credentials.get(model.provider))
            success = self._success.get((model.provider, fingerprint))
            recently_successful = bool(
                success and success[0] == model.id and success[1] > now
            )
            return (0 if recently_successful else 1, model.auto_priority)

        return tuple(sorted(pool, key=sort_key))

    def mark_success(
        self,
        model: ModelDefinition,
        credentials: LlmCredentials,
    ) -> None:
        """记录模型成功，并清除同模型和同供应商的短期失败状态。"""

        fingerprint = self._fingerprint(credentials.get(model.provider))
        now = time.monotonic()
        provider_key = (model.provider, fingerprint)
        model_key = (model.provider, fingerprint, model.id)
        self._success[provider_key] = (model.id, now + SUCCESS_TTL_SECONDS)
        self._provider_failures.pop(provider_key, None)
        self._model_failures.pop(model_key, None)

    def mark_failure(
        self,
        model: ModelDefinition,
        credentials: LlmCredentials,
        scope: str,
    ) -> None:
        """按错误作用域记录短期失败。

        ``model`` 作用域只屏蔽当前模型，例如 404 未开通；``provider`` 作用域代表
        网络、DNS、TLS 或鉴权问题，同一 Key 下继续切换模型没有意义。
        """

        fingerprint = self._fingerprint(credentials.get(model.provider))
        now = time.monotonic()
        if scope == "provider":
            self._provider_failures[(model.provider, fingerprint)] = CacheEntry(
                now + PROVIDER_FAILURE_TTL_SECONDS,
                scope,
            )
            return
        if scope == "model":
            self._model_failures[(model.provider, fingerprint, model.id)] = (
                CacheEntry(now + MODEL_FAILURE_TTL_SECONDS, scope)
            )

    def provider_blocked(
        self,
        provider: ProviderId,
        credentials: LlmCredentials,
        now: float | None = None,
    ) -> bool:
        """判断供应商是否处于短时网络/鉴权熔断期。"""

        current = time.monotonic() if now is None else now
        fingerprint = self._fingerprint(credentials.get(provider))
        key = (provider, fingerprint)
        entry = self._provider_failures.get(key)
        if not entry:
            return False
        if entry.expires_at <= current:
            self._provider_failures.pop(key, None)
            return False
        return True

    def clear(self) -> None:
        """清空缓存，供测试和未来设置页手动刷新使用。"""

        self._success.clear()
        self._model_failures.clear()
        self._provider_failures.clear()

    def _model_blocked(
        self,
        model: ModelDefinition,
        credentials: LlmCredentials,
        now: float,
    ) -> bool:
        """判断单个模型的失败缓存是否仍有效。"""

        fingerprint = self._fingerprint(credentials.get(model.provider))
        key = (model.provider, fingerprint, model.id)
        entry = self._model_failures.get(key)
        if not entry:
            return False
        if entry.expires_at <= now:
            self._model_failures.pop(key, None)
            return False
        return True

    def _fingerprint(self, secret: str | None) -> str:
        """生成不可逆短指纹，避免缓存键包含明文 API Key。"""

        value = (secret or "missing").encode("utf-8")
        return hashlib.sha256(value).hexdigest()[:16]


AVAILABILITY = ModelAvailabilityCache()
