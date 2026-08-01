"""把构建机的百炼兜底配置嵌入 Python 后端。

该脚本只读取允许嵌入的百炼变量，不会把 Gemini、Sentry、代理或电商平台凭证
一起带入安装包。生成结果使用压缩与编码降低误扫描和误打印风险，但这不是密码学
意义上的秘密保护：桌面应用中的共享 Key 最终仍可能被高级用户提取。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import zlib
from datetime import UTC, datetime
from pathlib import Path

from dotenv import dotenv_values


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV_FILE = ROOT / ".env.local"
GENERATED_FILE = ROOT / "backend" / "core" / "_builtin_credentials_generated.py"
ALLOWED_VARIABLES = ("DASHSCOPE_API_KEY", "DASHSCOPE_BASE_URL", "DASHSCOPE_MEDIA_BASE_URL")
ENCODING_CONTEXT = b"multi-agent-builtin-credentials-v1"


def _source_environment_file() -> Path:
    """返回用于生成内置凭证的环境文件路径。"""

    configured = os.getenv("BUILTIN_CREDENTIALS_ENV_FILE", "").strip()
    return Path(configured).expanduser().resolve() if configured else DEFAULT_ENV_FILE


def _read_allowed_values(source_file: Path) -> dict[str, str]:
    """只读取白名单中的百炼配置，避免误打包其他敏感变量。"""

    if not source_file.is_file():
        return {}
    parsed = dotenv_values(source_file)
    return {
        name: str(parsed.get(name) or "").strip()
        for name in ALLOWED_VARIABLES
        if str(parsed.get(name) or "").strip()
    }


def _xor_bytes(payload: bytes, salt: bytes) -> bytes:
    """使用可复现密钥流对数据做轻量混淆。"""

    output = bytearray()
    counter = 0
    while len(output) < len(payload):
        block = hashlib.sha256(
            ENCODING_CONTEXT + salt + counter.to_bytes(4, "big")
        ).digest()
        output.extend(block)
        counter += 1
    return bytes(value ^ output[index] for index, value in enumerate(payload))


def _encode_values(values: dict[str, str]) -> tuple[str, str, str]:
    """把配置压缩、混淆并返回载荷、盐值和完整性摘要。"""

    plain = json.dumps(
        values,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    compressed = zlib.compress(plain, level=9)
    salt = secrets.token_bytes(16)
    encoded = base64.b85encode(_xor_bytes(compressed, salt)).decode("ascii")
    return encoded, base64.b64encode(salt).decode("ascii"), hashlib.sha256(plain).hexdigest()


def _render_module(values: dict[str, str]) -> str:
    """生成不含明文凭证的 Python 模块源码。"""

    encoded, salt, digest = _encode_values(values)
    variable_names = tuple(sorted(values))
    generated_at = datetime.now(UTC).isoformat()
    return f'''"""构建时自动生成的内置百炼兜底配置，请勿手工修改。

该文件不包含明文 Key，但编码内容仍会随桌面安装包分发。需要轮换共享 Key 时，
请更新 .env.local 后重新执行 Python 后端构建。
"""

from __future__ import annotations

BUILTIN_CREDENTIALS_VERSION = 1
ENCODED_CREDENTIALS = {encoded!r}
ENCODING_SALT = {salt!r}
PAYLOAD_SHA256 = {digest!r}
EMBEDDED_VARIABLES = {variable_names!r}
GENERATED_AT = {generated_at!r}
'''


def embed_builtin_credentials() -> bool:
    """生成内置凭证模块；返回是否包含可用的百炼 Key。"""

    source_file = _source_environment_file()
    values = _read_allowed_values(source_file)

    if not values and GENERATED_FILE.is_file():
        # 完整交付包可能故意不附带 .env.local，但已经包含上一次生成的模块。
        # 此时保留现有模块，避免重新打包时把可用兜底覆盖成空配置。
        print("未找到新的 .env.local，保留现有内置百炼凭证模块。")
        existing = GENERATED_FILE.read_text("utf-8")
        return "DASHSCOPE_API_KEY" in existing and "ENCODED_CREDENTIALS = ''" not in existing

    if os.getenv("REQUIRE_BUILTIN_QWEN_KEY", "0").strip() == "1" and not values.get(
        "DASHSCOPE_API_KEY"
    ):
        raise SystemExit(
            "构建要求内置百炼兜底，但环境文件中没有 DASHSCOPE_API_KEY："
            f"{source_file}"
        )

    GENERATED_FILE.parent.mkdir(parents=True, exist_ok=True)
    GENERATED_FILE.write_text(_render_module(values), "utf-8")
    if values.get("DASHSCOPE_API_KEY"):
        print("已把百炼兜底配置嵌入 Python 后端生成模块（未输出密钥内容）。")
        return True

    print("未配置 DASHSCOPE_API_KEY，已生成空的内置凭证模块。")
    return False


def main() -> None:
    """命令行入口。"""

    embed_builtin_credentials()


if __name__ == "__main__":
    main()
