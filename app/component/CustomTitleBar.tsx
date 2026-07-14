// src/components/layout/CustomTitleBar.tsx
export default function CustomTitleBar() {
  return (
    <div
      className="w-full flex justify-between items-center px-4  custom-title-bar"
      style={{
        height: "42px",
        background: "#131321",
        pointerEvents: "none", // 核心：禁用鼠标事件，避免遮挡原生按钮的点击
        paddingRight: "220px", // 核心：给右侧的原生按钮留出 120px 的“禁区”
      }}
    >
      <span className="text-lg text-gray-500 font-medium">智能助手</span>

      {/* 注意：不需要在此处手动添加关闭按钮！
         因为我们在 main.ts 开启了 titleBarOverlay，
         Electron 会自动在该区域右侧渲染原生按钮。
      */}
    </div>
  );
}
