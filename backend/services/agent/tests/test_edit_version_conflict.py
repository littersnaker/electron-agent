"""apply_edit_operations 版本校验回归测试。

修复：一次 edit 内多组 operations 连续修改同一文件时，版本校验应只在
事务开始前执行一次，避免第一个写入后哈希变化导致后续操作误报
"内容已变化"而整体回滚。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.agent.shared.loop_protocol import EditOperation
from backend.services.agent.shared.workspace_tools import (
    apply_edit_operations,
    file_version,
)


def _file(tmp_path: Path) -> Path:
    path = tmp_path / "app.ts"
    path.write_text("import { View } from 'x'\n\nconst page = <View />\n", "utf-8")
    return path


def test_multi_operation_same_file_does_not_false_conflict(tmp_path) -> None:
    """同一 edit 内多组 replace 改同一文件不应误报内容已变化。"""

    path = _file(tmp_path)
    expected = {str(path.relative_to(tmp_path)): file_version(tmp_path, "app.ts")}

    result = apply_edit_operations(
        tmp_path,
        [
            EditOperation(
                type="replace",
                path="app.ts",
                old_text="import { View } from 'x'",
                new_text="import { View, ScrollView } from 'x'",
            ),
            EditOperation(
                type="replace",
                path="app.ts",
                old_text="const page = <View />",
                new_text="const page = <ScrollView />",
            ),
        ],
        expected_versions=expected,
    )

    content = path.read_text("utf-8")
    assert "ScrollView" in content
    assert "const page = <ScrollView />" in content
    assert result.changed_files == ["app.ts"]


def test_conflict_still_detected_before_any_write(tmp_path) -> None:
    """文件在读取后被外部修改，事务开始前仍应检测并整体拒绝。"""

    path = _file(tmp_path)
    expected = {"app.ts": file_version(tmp_path, "app.ts")}
    # 外部修改文件，使期望版本失效。
    path.write_text("// 外部修改\n" + path.read_text("utf-8"), "utf-8")

    with pytest.raises(ValueError, match="内容已变化"):
        apply_edit_operations(
            tmp_path,
            [
                EditOperation(
                    type="replace",
                    path="app.ts",
                    old_text="import { View } from 'x'",
                    new_text="import { View, ScrollView } from 'x'",
                )
            ],
            expected_versions=expected,
        )
