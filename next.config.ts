import type { NextConfig } from "next";

/**
 * Electron 开发服务通过 NEXT_DIST_DIR 使用独立缓存目录。
 * 普通 Web 开发与生产构建仍沿用 Next.js 默认的 `.next`。
 */
const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",
};

export default nextConfig;
