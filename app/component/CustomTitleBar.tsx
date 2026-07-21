export default function CustomTitleBar() {
  return (
    <div
      className="custom-title-bar flex w-full shrink-0 items-center border-b px-4"
      style={{
        height: "44px",
        background: "rgba(18, 18, 20, 0.82)",
        borderColor: "rgba(255, 255, 255, 0.075)",
        backdropFilter: "blur(28px) saturate(140%)",
        WebkitBackdropFilter: "blur(28px) saturate(140%)",
        pointerEvents: "none",
        paddingRight: "220px",
      }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border"
          style={{
            background:
              "linear-gradient(145deg, rgba(100,181,255,0.2), rgba(191,90,242,0.16))",
            borderColor: "rgba(255,255,255,0.08)",
          }}
        >
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
            <path
              d="M10 2.8c.48 3.46 2.44 5.42 5.9 5.9-3.46.48-5.42 2.44-5.9 5.9-.48-3.46-2.44-5.42-5.9-5.9 3.46-.48 5.42-2.44 5.9-5.9Z"
              fill="url(#title-star)"
            />
            <defs>
              <linearGradient id="title-star" x1="4" y1="3" x2="16" y2="15">
                <stop stopColor="#64b5ff" />
                <stop offset="1" stopColor="#bf5af2" />
              </linearGradient>
            </defs>
          </svg>
        </span>
        <span
          className="truncate text-[12px] font-semibold tracking-[-0.01em]"
          style={{ color: "rgba(245,245,247,0.78)" }}
        >
          Agent Workspace
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[9px] font-medium"
          style={{
            background: "rgba(255,255,255,0.055)",
            color: "rgba(235,235,245,0.35)",
          }}
        >
          Desktop
        </span>
      </div>
    </div>
  );
}
