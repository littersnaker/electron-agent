import type { NextConfig } from "next";

/**
 * Next.js 开发态与生产构建统一使用 `.next-electron`。
 * production standalone 服务会生成在 `.next-electron/standalone`。
 */
const nextConfig: NextConfig = {
  output: "standalone",
  distDir: ".next-electron",
};

export default nextConfig;
