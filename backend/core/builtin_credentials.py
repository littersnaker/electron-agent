"""读取打包进 Python 后端的共享兜底配置。

用户通过设置界面提交的 Key 始终优先；本模块只在用户没有配置且运行环境也没有
提供对应变量时使用。模块不会把凭证写入日志、接口响应或前端存储。
"""

from __future__ import annotations

import base64
import hashlib
import json
import zlib
from functools import lru_cache
from typing import Any

try:
    from backend.core._builtin_credentials_generated import (
        ENCODED_CREDENTIALS,
        ENCODING_SALT,
        PAYLOAD_SHA256,
    )
except ImportError:
    ENCODED_CREDENTIALS = ""
    ENCODING_SALT = ""
    PAYLOAD_SHA256 = ""


ENCODING_CONTEXT = b"multi-agent-builtin-credentials-v1"
ALLOWED_BUILTIN_VARIABLES = frozenset(
    {"DASHSCOPE_API_KEY", "DASHSCOPE_BASE_URL", "DASHSCOPE_MEDIA_BASE_URL"}
)


def _xor_bytes(payload: bytes, salt: bytes) -> bytes:
    """使用与构建脚本相同的密钥流还原压缩数据。"""

    output = bytearray()
    counter = 0
    while len(output) < len(payload):
        block = hashlib.sha256(
            ENCODING_CONTEXT + salt + counter.to_bytes(4, "big")
        ).digest()
        output.extend(block)
        counter += 1
    return bytes(value ^ output[index] for index, value in enumerate(payload))


def _normalize_payload(value: Any) -> dict[str, str]:
    """只保留允许的非空字符串字段，拒绝生成模块中的异常内容。"""

    if not isinstance(value, dict):
        return {}
    return {
        name: raw_value.strip()
        for name, raw_value in value.items()
        if name in ALLOWED_BUILTIN_VARIABLES
        and isinstance(raw_value, str)
        and raw_value.strip()
    }


@lru_cache(maxsize=1)
def get_builtin_settings() -> dict[str, str]:
    """解码并校验构建时嵌入的配置；损坏时安全返回空字典。"""

    if not ENCODED_CREDENTIALS or not ENCODING_SALT or not PAYLOAD_SHA256:
        return {}
    try:
        salt = base64.b64decode(ENCODING_SALT.encode("ascii"), validate=True)
        obfuscated = base64.b85decode(ENCODED_CREDENTIALS.encode("ascii"))
        compressed = _xor_bytes(obfuscated, salt)
        plain = zlib.decompress(compressed)
        if hashlib.sha256(plain).hexdigest() != PAYLOAD_SHA256:
            return {}
        return _normalize_payload(json.loads(plain.decode("utf-8")))
    except (ValueError, OSError, UnicodeError, json.JSONDecodeError):
        return {}


def get_builtin_value(variable_name: str) -> str:
    """读取指定内置变量；不在白名单或未配置时返回空字符串。"""

    if variable_name not in ALLOWED_BUILTIN_VARIABLES:
        return ""
    return get_builtin_settings().get(variable_name, "").strip()


def has_builtin_value(variable_name: str) -> bool:
    """判断指定内置变量是否存在，供状态接口使用。"""

    return bool(get_builtin_value(variable_name))
