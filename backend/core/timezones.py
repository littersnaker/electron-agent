"""跨平台时区解析和无 tzdata 时的安全回退。"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, timedelta, timezone, tzinfo
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

LOGGER = logging.getLogger(__name__)
PACIFIC_TIMEZONE = "America/Los_Angeles"


@lru_cache(maxsize=16)
def _load_zoneinfo(timezone_key: str) -> tzinfo | None:
    """加载系统或 tzdata 提供的时区，并缓存成功或失败结果。"""

    try:
        return ZoneInfo(timezone_key)
    except ZoneInfoNotFoundError:
        LOGGER.warning(
            "系统缺少时区数据库：%s；将使用应用内置的安全回退。",
            timezone_key,
        )
        return None


def _first_sunday_day(year: int, month: int) -> int:
    """返回指定年月中第一个星期日对应的日号。"""

    first_day = date(year, month, 1)
    return 1 + (6 - first_day.weekday()) % 7


def _pacific_fallback_zone(utc_moment: datetime) -> timezone:
    """根据美国 2007 年后的夏令时规则返回 PST 或 PDT 固定偏移。"""

    year = utc_moment.year
    daylight_start_day = _first_sunday_day(year, 3) + 7
    standard_start_day = _first_sunday_day(year, 11)
    daylight_start_utc = datetime(year, 3, daylight_start_day, 10, tzinfo=UTC)
    standard_start_utc = datetime(year, 11, standard_start_day, 9, tzinfo=UTC)
    if daylight_start_utc <= utc_moment < standard_start_utc:
        return timezone(timedelta(hours=-7), name="PDT")
    return timezone(timedelta(hours=-8), name="PST")


def now_in_timezone(
    timezone_key: str,
    *,
    at_utc: datetime | None = None,
) -> datetime:
    """返回目标时区时间；时区数据库缺失时不会让问答请求失败。

    ``America/Los_Angeles`` 会使用应用内置的 PST/PDT 规则回退。其他未知
    时区会安全退回 UTC，并通过日志提示缺少对应时区数据库。
    """

    utc_moment = at_utc or datetime.now(UTC)
    if utc_moment.tzinfo is None:
        utc_moment = utc_moment.replace(tzinfo=UTC)
    else:
        utc_moment = utc_moment.astimezone(UTC)

    resolved = _load_zoneinfo(timezone_key)
    if resolved is not None:
        return utc_moment.astimezone(resolved)
    if timezone_key == PACIFIC_TIMEZONE:
        return utc_moment.astimezone(_pacific_fallback_zone(utc_moment))
    return utc_moment


def timezone_source(timezone_key: str) -> str:
    """返回当前时区由系统数据库、内置回退还是 UTC 回退提供。"""

    if _load_zoneinfo(timezone_key) is not None:
        return "zoneinfo"
    if timezone_key == PACIFIC_TIMEZONE:
        return "builtin-pacific-fallback"
    return "utc-fallback"
