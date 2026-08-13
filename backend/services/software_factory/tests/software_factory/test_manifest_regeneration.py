"""manifest 确定性重建测试：扫描/哈希/合并既有条目/工具协议。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.services.software_factory.service import SOFTWARE_FACTORY


@pytest.mark.asyncio
async def test_regenerate_manifest_scans_and_hashes(tmp_path: Path) -> None:
    """regenerate_manifest 应扫描项目文件、计算非空 sha256 并写入 output_root。"""

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "App.tsx").write_text("export const App = () => <h1>hi</h1>;", encoding="utf-8")
    (tmp_path / "package.json").write_text('{"name":"x"}', encoding="utf-8")
    (tmp_path / "features" / "commerce").mkdir(parents=True)
    (tmp_path / "features" / "commerce" / "data-source.ts").write_text(
        "export const ds = 1;", encoding="utf-8"
    )

    result = await __import__("asyncio").to_thread(
        SOFTWARE_FACTORY.regenerate_manifest,
        root=tmp_path,
        output_root="features/commerce",
    )
    assert result.get("ok") is True, result

    manifest_path = tmp_path / "features" / "commerce" / "software-factory.manifest.json"
    manifest = json.loads(manifest_path.read_text("utf-8"))
    paths = [item["path"] for item in manifest["files"]]
    assert "src/App.tsx" in paths
    assert "package.json" in paths
    assert "features/commerce/data-source.ts" in paths
    # 所有条目 sha256 非空。
    for item in manifest["files"]:
        assert item["sha256"], item


@pytest.mark.asyncio
async def test_regenerate_manifest_preserves_existing_entries(tmp_path: Path) -> None:
    """既有 manifest 的 features/commerce 条目应保留原哈希，避免漂移误报。"""

    (tmp_path / "features" / "commerce").mkdir(parents=True)
    (tmp_path / "features" / "commerce" / "data-source.ts").write_text(
        "export const ds = 1;", encoding="utf-8"
    )
    original_manifest = tmp_path / "features" / "commerce" / "software-factory.manifest.json"
    original_manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "domainId": "commerce-miniapp",
                "frontendStack": "typescript",
                "outputRoot": "features/commerce",
                "files": [
                    {
                        "path": "features/commerce/data-source.ts",
                        "kind": "frontend",
                        "sha256": "ORIGINAL-HASH",
                        "lineCount": 1,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    await __import__("asyncio").to_thread(
        SOFTWARE_FACTORY.regenerate_manifest,
        root=tmp_path,
        output_root="features/commerce",
    )

    manifest = json.loads(original_manifest.read_text("utf-8"))
    entry = next(
        item
        for item in manifest["files"]
        if item["path"] == "features/commerce/data-source.ts"
    )
    assert entry["sha256"] == "ORIGINAL-HASH"  # 既有条目保留原哈希。


def test_factory_manifest_mode_allowed() -> None:
    """协议层应允许 factory mode=manifest。"""

    from backend.services.agent.shared.loop_protocol import ActionRequestModel

    model = ActionRequestModel(
        action="factory",
        mode="manifest",
        output_root="features/commerce",
    )
    assert model.mode == "manifest"
