import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // Playwright 仅在服务端 Commerce 爬虫中使用。保持为外部包，避免 Next.js 将浏览器驱动
  // 错误打进客户端或对其动态加载文件做不兼容的打包转换。
  serverExternalPackages: ["playwright-core"],
};

const isElectronBuild = process.env.IS_ELECTRON_BUILD === "true";

export default withSentryConfig(config, {
  org: "next-agent",
  project: "javascript-nextjs",

  silent: !process.env.CI,

  widenClientFileUpload: true,

  tunnelRoute: "/monitoring",

  webpack: {
    // Disable Vercel cron monitors when building for Electron
    automaticVercelMonitors: !isElectronBuild,

    treeshake: {
      removeDebugLogging: true,
    },
  },
});
