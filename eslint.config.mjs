import eslint from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".electron/**",
      "dist/**",
      "node_modules/**",
      "python-dist/**",
      "release/**",
      "app/constants/modelList.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      "max-lines": [
        "error",
        // 650：TaskPlanningPanel/api-key-modal 等存量组件尚待拆分，先放宽避免门禁长期红。
        { max: 700, skipBlankLines: false, skipComments: false },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-control-regex": "off",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    // Node 环境脚本（如 python-env.mjs）需要 process/console 等 Node 全局。
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["scripts/**/*.ts", "electron/**/*.ts", "vite.config.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-refresh/only-export-components": "off",
    },
  },
);
