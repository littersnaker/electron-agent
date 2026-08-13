"""Spill 落盘测试：阈值、落盘、预览、取回、关闭。"""

from __future__ import annotations

from pathlib import Path

from backend.services.agent.spill import SpillStore, maybe_spill_result


def test_small_output_passes_through(monkeypatch, tmp_path: Path) -> None:
    """小输出不应落盘，原样返回。"""

    monkeypatch.setenv("CODE_AGENT_SPILL_THRESHOLD_BYTES", "1024")
    store = SpillStore(tmp_path)
    result = maybe_spill_result(store, session_id="w1", tool_name="read", text="short")

    assert result == "short"
    assert not (tmp_path / ".agent-data").exists()


def test_large_output_spills_and_returns_locator(monkeypatch, tmp_path: Path) -> None:
    """超阈值输出应落盘并返回定位符 + 预览。"""

    monkeypatch.setenv("CODE_AGENT_SPILL_THRESHOLD_BYTES", "8")
    store = SpillStore(tmp_path)
    content = "\n".join(f"line-{index}" for index in range(300))
    result = maybe_spill_result(store, session_id="w1", tool_name="read", text=content)

    assert "[SPILLED]" in result
    assert ".agent-data/spill/w1/" in result
    assert "line-0" in result  # 预览包含开头
    # 落盘文件存在且内容完整。
    spill_files = list((tmp_path / ".agent-data" / "spill" / "w1").glob("*.txt"))
    assert spill_files
    assert spill_files[0].read_text("utf-8") == content


def test_spill_idempotent_same_content(monkeypatch, tmp_path: Path) -> None:
    """同内容两次落盘只写一个文件（哈希幂等）。"""

    monkeypatch.setenv("CODE_AGENT_SPILL_THRESHOLD_BYTES", "8")
    store = SpillStore(tmp_path)
    maybe_spill_result(store, session_id="w1", tool_name="read", text="x" * 100)
    maybe_spill_result(store, session_id="w1", tool_name="read", text="x" * 100)

    files = list((tmp_path / ".agent-data" / "spill" / "w1").glob("*.txt"))
    assert len(files) == 1


def test_spill_disabled_by_zero(monkeypatch, tmp_path: Path) -> None:
    """阈值 0 表示关闭 spill。"""

    monkeypatch.setenv("CODE_AGENT_SPILL_THRESHOLD_BYTES", "0")
    store = SpillStore(tmp_path)
    result = maybe_spill_result(store, session_id="w1", tool_name="run", text="x" * 1000)

    assert result == "x" * 1000
    assert not (tmp_path / ".agent-data").exists()
