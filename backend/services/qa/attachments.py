"""QA Agent 图片附件的安全转换逻辑。"""

from __future__ import annotations

import base64
import re

from backend.schemas.common import FrontendAttachment
from backend.services.llm.types import ImagePart


def decode_image_attachment(attachment: FrontendAttachment) -> ImagePart:
    """把前端附件转换成模型网关使用的图片对象。

    方法会同时兼容独立 ``data`` 字段和完整 ``dataUrl`` 字段，并在数据进入模型
    网关前完成 MIME 类型与 Base64 校验，避免无效内容在供应商接口处才报错。
    """

    mime_type = attachment.mime_type.strip()
    encoded_data = (attachment.data or "").strip()

    # 浏览器通常优先传入 data URL；解析成功后用其中的 MIME 和正文覆盖独立字段。
    if attachment.data_url:
        match = re.match(
            r"^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$",
            attachment.data_url.strip(),
            re.IGNORECASE,
        )
        if match:
            mime_type = match.group(1)
            encoded_data = match.group(2)

    # Base64 中可能带有换行或空格，先清理再执行严格校验。
    encoded_data = re.sub(r"\s+", "", encoded_data)
    if not mime_type.startswith("image/"):
        raise ValueError(f"附件 {attachment.name} 不是图片")
    if not encoded_data:
        raise ValueError(f"附件 {attachment.name} 缺少图片数据")

    try:
        base64.b64decode(encoded_data, validate=True)
    except ValueError as exc:
        raise ValueError(f"附件 {attachment.name} 的 Base64 数据无效") from exc

    return ImagePart(mime_type, encoded_data, attachment.name)
