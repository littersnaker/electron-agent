import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
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
