"""桌面应用偏好设置接口的数据结构。"""

from __future__ import annotations

from typing import Literal

from backend.schemas.common import FlexibleModel


ThemeMode = Literal["dark", "light"]


class ThemePreference(FlexibleModel):
    """当前保存的界面主题；首次运行时可以为空。"""

    theme: ThemeMode | None = None


class ThemePreferenceUpdate(FlexibleModel):
    """更新界面主题时使用的请求体。"""

    theme: ThemeMode
