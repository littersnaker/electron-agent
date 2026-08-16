"""标签裁剪与分批识别测试。"""

from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw

from backend.services.glm46v.client import GLM46VSettings, ImageInput
from backend.services.image.locate import TagBox
from backend.services.image.preprocess import crop_tag
from backend.services.image.recognition import (
    build_tag_batch_prompt,
    recognize_tag_batches,
)


def _tag_image_bytes(color: tuple[int, int, int] = (220, 30, 30)) -> bytes:
    image = Image.new("RGB", (400, 300), (60, 60, 62))
    draw = ImageDraw.Draw(image)
    draw.ellipse([160, 110, 240, 190], fill=color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_crop_tag_upscales_and_encodes() -> None:
    box = TagBox(x=140, y=90, w=120, h=120, row=1, col=1)
    crop = crop_tag(
        image_bytes=_tag_image_bytes(),
        box=box,
        upscale=4,
        name="tag_r1c1q1.jpg",
    )
    assert crop.name == "tag_r1c1q1.jpg"
    assert crop.mime_type == "image/jpeg"
    assert crop.size_bytes > 0
    from PIL import Image as PILImage

    decoded = PILImage.open(io.BytesIO(__import__("base64").b64decode(crop.data)))
    # 原图 120x120 裁剪 + 4x 放大
    assert decoded.width >= 400
    assert decoded.height >= 400


def test_crop_tag_invalid_box_raises() -> None:
    from backend.services.glm46v.client import GLM46VError

    with pytest.raises(GLM46VError):
        crop_tag(image_bytes=_tag_image_bytes(), box=TagBox(0, 0, 0, 0, 1, 1))


class SequenceClient:
    """按批次返回编号，内容按图片顺序逐行输出（维护跨批偏移）。"""

    def __init__(self, numbers: list[str]) -> None:
        self.numbers = numbers
        self.calls: list[int] = []
        self._offset = 0

    @property
    def settings(self) -> GLM46VSettings:
        return GLM46VSettings(api_key="fake", endpoint="https://example.test")

    async def analyze_images(self, images, *, prompt: str, max_tokens: int = 6144):
        self.calls.append(len(images))
        lines = self.numbers[self._offset : self._offset + len(images)]
        self._offset += len(images)
        return {"model": "glm-4.6v-flash", "content": "\n".join(lines), "usage": {}}


def _crop(name: str) -> ImageInput:
    return ImageInput(name=name, mime_type="image/jpeg", data="cXVhY2s=", size_bytes=5)


@pytest.mark.asyncio
async def test_recognize_tag_batches_splits_by_8() -> None:
    client = SequenceClient([f"{index}" for index in range(1, 21)])
    crops = [_crop(f"t{index}") for index in range(1, 21)]
    numbers = await recognize_tag_batches(crops=crops, client=client)
    assert client.calls == [8, 8, 4]  # 20 张按 8/8/4 分批
    assert numbers == [str(index) for index in range(1, 21)]


@pytest.mark.asyncio
async def test_recognize_tag_batches_keeps_order_with_unclear() -> None:
    class UnclearClient:
        @property
        def settings(self) -> GLM46VSettings:
            return GLM46VSettings(api_key="fake", endpoint="https://example.test")

        async def analyze_images(self, images, *, prompt: str, max_tokens: int = 6144):
            return {
                "model": "glm-4.6v-flash",
                "content": "325\n无法辨认\n89\n302",
                "usage": {},
            }

    crops = [_crop("a"), _crop("b"), _crop("c"), _crop("d")]
    numbers = await recognize_tag_batches(crops=crops, client=UnclearClient())
    assert numbers == ["325", None, "89", "302"]


@pytest.mark.asyncio
async def test_recognize_tag_batches_degrades_on_batch_failure() -> None:
    class FailingClient:
        @property
        def settings(self) -> GLM46VSettings:
            return GLM46VSettings(api_key="fake", endpoint="https://example.test")

        async def analyze_images(self, images, *, prompt: str, max_tokens: int = 6144):
            raise RuntimeError("mock 失败")

    numbers = await recognize_tag_batches(
        crops=[_crop("a"), _crop("b")], client=FailingClient()
    )
    assert numbers == [None, None]


def test_build_tag_batch_prompt() -> None:
    prompt = build_tag_batch_prompt(3)
    assert "按顺序" in prompt
    assert "3 张" in prompt
