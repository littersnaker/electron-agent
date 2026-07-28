import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    ".next-electron/**",
    ".electron/**",
    "release/**",
    "out/**",
    "out-server/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
