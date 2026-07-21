export const getCurrentTime = (timeZone?: string) => {

  const zone = timeZone || "Asia/Shanghai";

  const now = new Date();

  return {
    utc: now.toISOString(),

    local:
      new Intl.DateTimeFormat(
        "zh-CN",
        {
          timeZone: zone,
          dateStyle: "full",
          timeStyle: "long",
          hour12: false,
        }
      ).format(now),

    timeZone: zone,
  };
}