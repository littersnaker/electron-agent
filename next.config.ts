import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography"; // 🔥 1. 在顶部用 ES6 import 引入

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [
    typography, // 🔥 2. 将这里直接替换为变量名，别写 require
  ],
};

export default config;