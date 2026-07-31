// 模块说明：Vite React 前端开发和生产构建配置。

import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

/**
 * 导出开发服务器、路径别名和生产构建设置。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // 保留原项目的 `@/app/...` 导入写法，避免迁移时大范围改动组件代码。
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
