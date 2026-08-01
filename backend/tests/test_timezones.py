"""跨平台时区数据库缺失场景回归测试。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from backend.core import timezones


def test_pacific_fallback_uses_daylight_offset(monkeypatch) -> None:
    """验证缺少 tzdata 时，夏季时间仍按 PDT 的 UTC-7 返回。"""

    monkeypatch.setattr(timezones, "_load_zoneinfo", lambda _: None)
    moment = datetime(2026, 8, 1, 12, tzinfo=UTC)
    result = timezones.now_in_timezone(timezones.PACIFIC_TIMEZONE, at_utc=moment)
    assert result.utcoffset() == timedelta(hours=-7)
    assert result.tzname() == "PDT"


def test_pacific_fallback_uses_standard_offset(monkeypatch) -> None:
    """验证缺少 tzdata 时，冬季时间仍按 PST 的 UTC-8 返回。"""

    monkeypatch.setattr(timezones, "_load_zoneinfo", lambda _: None)
    moment = datetime(2026, 1, 15, 12, tzinfo=UTC)
    result = timezones.now_in_timezone(timezones.PACIFIC_TIMEZONE, at_utc=moment)
    assert result.utcoffset() == timedelta(hours=-8)
    assert result.tzname() == "PST"


def test_unknown_timezone_falls_back_to_utc(monkeypatch) -> None:
    """验证未知时区不会中断问答，而是安全回退到 UTC。"""

    monkeypatch.setattr(timezones, "_load_zoneinfo", lambda _: None)
    moment = datetime(2026, 8, 1, 12, tzinfo=UTC)
    result = timezones.now_in_timezone("Example/Missing", at_utc=moment)
    assert result.utcoffset() == timedelta(0)


def test_pacific_fallback_switches_at_dst_boundaries(monkeypatch) -> None:
    """验证内置回退在 2026 年夏令时起止时刻准确切换偏移。"""

    monkeypatch.setattr(timezones, "_load_zoneinfo", lambda _: None)
    before_start = timezones.now_in_timezone(
        timezones.PACIFIC_TIMEZONE,
        at_utc=datetime(2026, 3, 8, 9, 59, tzinfo=UTC),
    )
    after_start = timezones.now_in_timezone(
        timezones.PACIFIC_TIMEZONE,
        at_utc=datetime(2026, 3, 8, 10, 0, tzinfo=UTC),
    )
    before_end = timezones.now_in_timezone(
        timezones.PACIFIC_TIMEZONE,
        at_utc=datetime(2026, 11, 1, 8, 59, tzinfo=UTC),
    )
    after_end = timezones.now_in_timezone(
        timezones.PACIFIC_TIMEZONE,
        at_utc=datetime(2026, 11, 1, 9, 0, tzinfo=UTC),
    )
    assert before_start.utcoffset() == timedelta(hours=-8)
    assert after_start.utcoffset() == timedelta(hours=-7)
    assert before_end.utcoffset() == timedelta(hours=-7)
    assert after_end.utcoffset() == timedelta(hours=-8)
