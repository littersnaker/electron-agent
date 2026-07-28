// 模块说明：负责 layout 页面或应用入口逻辑。
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Multi-agent",
  description: "基于通义千问与 LangGraph 的智能对话助手",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
