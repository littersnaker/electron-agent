"""以中文表格打印 config/chat-models.json 中的模型路由顺序。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "chat-models.json"


def _load_models() -> list[dict[str, Any]]:
    """读取模型 JSON，并返回模型数组。"""

    payload = json.loads(CONFIG_PATH.read_text("utf-8"))
    models = payload.get("models")
    if not isinstance(models, list):
        raise SystemExit("config/chat-models.json 中缺少 models 数组")
    return [item for item in models if isinstance(item, dict)]


def _route_type(model: dict[str, Any]) -> str:
    """根据 Auto 开关返回中文路由类型。"""

    if bool(model.get("autoSelect", True)):
        return "Auto 主候选"
    if bool(model.get("fallbackSelect", False)):
        return "Auto 后备"
    return "仅手动选择"


def _print_group(title: str, models: list[dict[str, Any]]) -> None:
    """打印一组按优先级排序的模型。"""

    print(f"\n{title}")
    print("-" * 106)
    print(f"{'顺序':<6}{'路由类型':<14}{'供应商':<12}{'真实 model':<28}{'界面名称'}")
    print("-" * 106)
    for index, model in enumerate(models, start=1):
        print(
            f"{index:<6}{_route_type(model):<14}"
            f"{str(model.get('provider', '')):<12}"
            f"{str(model.get('model', '')):<28}"
            f"{str(model.get('name', ''))}"
        )


def main() -> None:
    """打印 Auto 候选和仅手动模型，便于非 Python 开发者核对。"""

    models = _load_models()
    auto_models = sorted(
        [
            model
            for model in models
            if bool(model.get("autoSelect", True))
            or bool(model.get("fallbackSelect", False))
        ],
        key=lambda model: int(model.get("autoPriority", 100)),
    )
    manual_models = [
        model
        for model in models
        if not bool(model.get("autoSelect", True))
        and not bool(model.get("fallbackSelect", False))
    ]
    _print_group("Auto Router 当前候选顺序（数字越小越先尝试）", auto_models)
    _print_group("仅在下拉框手动选择的模型", manual_models)
    print("\n修改入口：config/chat-models.json")
    print("保存后，pnpm dev 会自动同步前端和 Python，无需手改生成文件。")


if __name__ == "__main__":
    main()
