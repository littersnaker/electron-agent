"""货架照片预处理：清晰度增强与放大，输出 GLM-4.6V 可用的 Base64 图片。

识别前先用 Pillow 做确定性增强（UnsharpMask + LANCZOS 2x 放大），让 GLM-4.6V
看清小字图纸编号。全程不落盘、不引入随机性，保证同一输入产出同一结果。
"""

from __future__ import annotations

import base64
import binascii
import io
import os

from backend.services.glm46v.client import GLM46VError, ImageInput

UPSCALE_FACTOR = 2
TARGET_EDGE_PIXELS = 1536
ENHANCE_STRENGTH = float(os.getenv("IMAGE_ENHANCE_STRENGTH", "1.6"))
MAX_JPEG_BYTES = int(os.getenv("IMAGE_MAX_JPEG_BYTES", str(20 * 1024 * 1024)))


def preprocess_image(
    *,
    name: str,
    mime_type: str,
    data: str,
    max_image_mb: float,
) -> ImageInput:
    """对一张上传图片做增强放大并返回可识别的 ImageInput。

    尺寸超过 ``TARGET_EDGE_PIXELS`` 的大图先等比缩小到目标边长，再统一做
    UnsharpMask 清晰度增强与 2x 放大；JPEG 输出超过 ``IMAGE_MAX_JPEG_BYTES``
    时降质到 70% 重压缩。失败抛 GLM46VError，由上层按降级策略处理。
    """

    try:
        from PIL import Image, ImageFilter, ImageOps
    except ImportError as exc:  # pragma: no cover - 构建环境必带 Pillow
        raise GLM46VError("图片识别依赖 Pillow 未安装，无法增强图片。") from exc

    raw = _decode_base64(data)
    if not raw:
        raise GLM46VError(f"图片 {name or 'attachment'} 没有有效数据。")
    max_bytes = int(max_image_mb * 1024 * 1024)
    if len(raw) > max_bytes:
        raise GLM46VError(
            f"图片 {name or 'attachment'} 大小为 {len(raw) / 1024 / 1024:.2f} MB，"
            f"超过 {max_image_mb:.2f} MB 限制。"
        )
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except Exception as exc:
        raise GLM46VError(f"图片 {name or 'attachment'} 无法解码：{exc}") from exc
    if image.mode != "RGB":
        image = ImageOps.exif_transpose(image).convert("RGB")

    # 大图先等比缩到目标边长，再统一增强放大，避免超大图把放大时间拖长。
    width, height = image.size
    longest = max(width, height)
    if longest > TARGET_EDGE_PIXELS:
        scale = TARGET_EDGE_PIXELS / longest
        image = image.resize(
            (max(1, int(width * scale)), max(1, int(height * scale))),
            Image.Resampling.LANCZOS,
        )

    enhanced = image.filter(
        ImageFilter.UnsharpMask(
            radius=2,
            percent=int(150 * ENHANCE_STRENGTH),
            threshold=3,
        )
    )
    upscaled = enhanced.resize(
        (
            enhanced.width * UPSCALE_FACTOR,
            enhanced.height * UPSCALE_FACTOR,
        ),
        Image.Resampling.LANCZOS,
    )

    jpeg_bytes = _encode_jpeg(upscaled)
    if len(jpeg_bytes) > MAX_JPEG_BYTES:
        jpeg_bytes = _encode_jpeg(upscaled, quality=70)
    encoded = base64.b64encode(jpeg_bytes).decode("ascii")
    return ImageInput(
        name=name.strip() or "shelf.jpg",
        mime_type="image/jpeg",
        data=encoded,
        size_bytes=len(jpeg_bytes),
    )


def _decode_base64(data: str) -> bytes:
    stripped = data.strip()
    if stripped.startswith("data:"):
        _, _, payload = stripped.partition(",")
        if payload:
            stripped = payload.strip()
    try:
        return base64.b64decode("".join(stripped.split()), validate=False)
    except (ValueError, binascii.Error):
        return b""


def crop_tag(
    *,
    image_bytes: bytes,
    box: object,
    upscale: int = 4,
    name: str = "tag.jpg",
) -> ImageInput:
    """按定位框裁剪单个标签小图并放大，输出 GLM 可识别的 ImageInput。

    定位框坐标来自 ``locate.py`` 的 TagBox（已带外边距）；裁剪后 LANCZOS
    放大 ``upscale`` 倍并转 JPEG，让编号数字足够清晰。失败抛 GLM46VError，
    由上层按降级策略处理。
    """

    try:
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - 构建环境必带 Pillow
        raise GLM46VError("图片识别依赖 Pillow 未安装，无法裁剪标签。") from exc

    x = int(box.x)
    y = int(box.y)
    w = int(box.w)
    h = int(box.h)
    if w <= 0 or h <= 0:
        raise GLM46VError("标签定位框尺寸无效，无法裁剪。")

    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
    except Exception as exc:
        raise GLM46VError(f"标签裁剪失败：{exc}") from exc
    if image.mode != "RGB":
        image = image.convert("RGB")

    region = image.crop(
        (
            max(0, x),
            max(0, y),
            min(image.width, x + w),
            min(image.height, y + h),
        )
    )
    if region.width <= 0 or region.height <= 0:
        raise GLM46VError("标签裁剪区域为空。")
    region = region.resize(
        (region.width * max(1, upscale), region.height * max(1, upscale)),
        Image.Resampling.LANCZOS,
    )
    jpeg_bytes = _encode_jpeg(region)
    encoded = base64.b64encode(jpeg_bytes).decode("ascii")
    return ImageInput(
        name=name.strip() or "tag.jpg",
        mime_type="image/jpeg",
        data=encoded,
        size_bytes=len(jpeg_bytes),
    )


def _encode_jpeg(image, quality: int = 85) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality, optimize=True)
    return buffer.getvalue()


__all__ = ["ENHANCE_STRENGTH", "UPSCALE_FACTOR", "crop_tag", "preprocess_image"]
