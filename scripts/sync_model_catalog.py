"""把易编辑的 JSON 模型表同步为 Python 与 TypeScript 注册表。

开发者只需要修改 ``config/chat-models.json``。本脚本会生成后端和前端各自
可以直接导入的文件，避免同一个模型名在两处手工维护后发生不一致。
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "chat-models.json"
PYTHON_OUTPUT = ROOT / "backend" / "services" / "llm" / "catalog_generated.py"
TYPESCRIPT_OUTPUT = ROOT / "app" / "lib" / "llm" / "registry" / "models.generated.ts"
ALLOWED_PROVIDERS = {"qwen", "openai", "gemini", "deepseek", "glm", "kimi"}
REQUIRED_MODEL_FIELDS = {
    "id",
    "provider",
    "model",
    "name",
    "description",
    "capabilities",
    "recommendedTasks",
    "quality",
    "speed",
    "costEfficiency",
}


def _load_config() -> dict[str, Any]:
    """读取 JSON，并确保顶层结构完整。"""

    try:
        payload = json.loads(CONFIG_PATH.read_text("utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"模型配置不存在：{CONFIG_PATH}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"模型配置 JSON 格式错误：第 {exc.lineno} 行，第 {exc.colno} 列"
        ) from exc
    if not isinstance(payload, dict):
        raise ValueError("模型配置顶层必须是 JSON 对象")
    if not isinstance(payload.get("models"), list) or not payload["models"]:
        raise ValueError("models 必须是非空数组")
    if not isinstance(payload.get("aliases", {}), dict):
        raise ValueError("aliases 必须是对象")
    return payload


def _normalize_model(raw: object, index: int) -> dict[str, Any]:
    """校验并补齐单个模型条目的默认字段。"""

    if not isinstance(raw, dict):
        raise ValueError(f"models[{index}] 必须是对象")
    missing = sorted(REQUIRED_MODEL_FIELDS.difference(raw))
    if missing:
        raise ValueError(f"models[{index}] 缺少字段：{', '.join(missing)}")

    provider = str(raw["provider"]).strip()
    if provider not in ALLOWED_PROVIDERS:
        raise ValueError(f"models[{index}].provider 不支持：{provider}")
    model_id = str(raw["id"]).strip()
    vendor_model = str(raw["model"]).strip()
    if not model_id or ":" not in model_id:
        raise ValueError(f"models[{index}].id 应采用 provider:model 格式")
    if not vendor_model:
        raise ValueError(f"models[{index}].model 不能为空")

    capabilities = raw["capabilities"]
    tasks = raw["recommendedTasks"]
    if not isinstance(capabilities, list) or not all(
        isinstance(item, str) and item for item in capabilities
    ):
        raise ValueError(f"models[{index}].capabilities 必须是字符串数组")
    if not isinstance(tasks, list) or not all(
        isinstance(item, str) and item for item in tasks
    ):
        raise ValueError(f"models[{index}].recommendedTasks 必须是字符串数组")

    return {
        "id": model_id,
        "provider": provider,
        "model": vendor_model,
        "name": str(raw["name"]).strip(),
        "description": str(raw["description"]).strip(),
        "capabilities": list(capabilities),
        "recommendedTasks": list(tasks),
        "quality": int(raw["quality"]),
        "speed": int(raw["speed"]),
        "costEfficiency": int(raw["costEfficiency"]),
        "autoSelect": bool(raw.get("autoSelect", True)),
        "fallbackSelect": bool(raw.get("fallbackSelect", False)),
        "autoPriority": int(raw.get("autoPriority", 100)),
        "chatCompatible": bool(raw.get("chatCompatible", True)),
    }


def _normalize_config(payload: dict[str, Any]) -> dict[str, Any]:
    """校验模型 ID、别名与默认模型，并返回稳定结构。"""

    models = [
        _normalize_model(raw, index)
        for index, raw in enumerate(payload["models"])
    ]
    ids = [str(model["id"]) for model in models]
    duplicates = sorted({model_id for model_id in ids if ids.count(model_id) > 1})
    if duplicates:
        raise ValueError(f"模型逻辑 ID 重复：{', '.join(duplicates)}")

    default_model_id = str(payload.get("defaultModelId", "")).strip()
    if default_model_id not in ids:
        raise ValueError(f"defaultModelId 未出现在 models 中：{default_model_id}")

    aliases = {
        str(key).strip(): str(value).strip()
        for key, value in payload.get("aliases", {}).items()
        if str(key).strip() and str(value).strip()
    }
    unknown_targets = sorted({value for value in aliases.values() if value not in ids})
    if unknown_targets:
        raise ValueError(f"aliases 指向不存在的模型：{', '.join(unknown_targets)}")
    return {
        "defaultModelId": default_model_id,
        "aliases": aliases,
        "models": models,
    }


def _render_python(payload: dict[str, Any]) -> str:
    """生成后端可导入的 Python 常量文件。"""

    model_lines = ",\n".join(f"    {model!r}" for model in payload["models"])
    return (
        '"""由 scripts/sync_model_catalog.py 自动生成，请勿直接修改。"""\n\n'
        "from __future__ import annotations\n\n"
        f"DEFAULT_MODEL_ID = {payload['defaultModelId']!r}\n"
        f"MODEL_ID_ALIASES = {payload['aliases']!r}\n"
        "MODEL_CATALOG_DATA: tuple[dict[str, object], ...] = (\n"
        f"{model_lines},\n"
        ")\n"
    )


def _render_typescript(payload: dict[str, Any]) -> str:
    """生成前端可导入的 TypeScript 常量文件。"""

    model_lines = ",\n".join(
        f"  {json.dumps(model, ensure_ascii=False, separators=(',', ':'))}"
        for model in payload["models"]
    )
    aliases = json.dumps(
        payload["aliases"], ensure_ascii=False, separators=(",", ":")
    )
    default_id = json.dumps(payload["defaultModelId"], ensure_ascii=False)
    return (
        "// 此文件由 scripts/sync_model_catalog.py 自动生成，请勿直接修改。\n"
        f"export const GENERATED_DEFAULT_MODEL_ID = {default_id} as const;\n"
        f"export const GENERATED_MODEL_ID_ALIASES = {aliases} as const;\n"
        "export const GENERATED_MODEL_CATALOG = [\n"
        f"{model_lines},\n"
        "] as const;\n"
    )


def _write_if_changed(path: Path, content: str) -> bool:
    """只有内容变化时才写文件，避免无意义触发 Vite/Uvicorn 重载。"""

    if path.is_file() and path.read_text("utf-8") == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, "utf-8")
    return True


def sync_model_catalog() -> bool:
    """执行一次模型目录同步，并返回是否真的更新了生成文件。"""

    payload = _normalize_config(_load_config())
    python_changed = _write_if_changed(PYTHON_OUTPUT, _render_python(payload))
    typescript_changed = _write_if_changed(
        TYPESCRIPT_OUTPUT, _render_typescript(payload)
    )
    changed = python_changed or typescript_changed
    action = "已更新" if changed else "无需更新"
    print(f"[模型同步] {action}：{len(payload['models'])} 个聊天模型")
    return changed


def _watch(interval_seconds: float) -> None:
    """轮询 JSON 修改时间；保存后自动重新生成前后端注册表。"""

    last_stamp = -1
    print(f"[模型同步] 正在监听：{CONFIG_PATH}")
    while True:
        try:
            stamp = CONFIG_PATH.stat().st_mtime_ns
            if stamp != last_stamp:
                sync_model_catalog()
                last_stamp = stamp
        except (OSError, ValueError) as exc:
            print(f"[模型同步] 配置暂时无效，保留上一次可用结果：{exc}")
        time.sleep(interval_seconds)


def _parse_arguments() -> argparse.Namespace:
    """解析一次同步或持续监听参数。"""

    parser = argparse.ArgumentParser(description="同步聊天模型 JSON 注册表")
    parser.add_argument("--watch", action="store_true", help="持续监听 JSON 修改")
    parser.add_argument("--interval", type=float, default=0.5, help="轮询间隔秒数")
    return parser.parse_args()


def main() -> None:
    """命令行入口。"""

    arguments = _parse_arguments()
    if arguments.watch:
        _watch(max(0.2, arguments.interval))
    else:
        sync_model_catalog()


if __name__ == "__main__":
    main()
