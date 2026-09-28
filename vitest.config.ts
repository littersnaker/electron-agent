// 模块说明：Vitest 前端单测配置（复用 vite.config.ts 的路径别名与 React 插件）。
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["app/**/*.test.{ts,tsx}"],
  },
});
