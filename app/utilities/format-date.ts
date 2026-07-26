// 模块说明：提供统一的日期时间格式化能力。
export interface CurrentDateTime {
  utc: string;
  local: string;
  timeZone: string;
}

/** 返回指定时区的 UTC 与本地时间文本。 */
export function getCurrentDateTime(timeZone = "Asia/Shanghai"): CurrentDateTime {
  const currentDate = new Date();

  return {
    utc: currentDate.toISOString(),
    local: new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      dateStyle: "full",
      timeStyle: "long",
      hour12: false,
    }).format(currentDate),
    timeZone,
  };
}

/** @deprecated 请使用语义更清晰的 getCurrentDateTime。 */
export const getCurrentTime = getCurrentDateTime;
