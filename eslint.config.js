import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // The verdict engine is a standalone module (plan section 4b): Bucket's UI is one
    // consumer of it, not the only place it can live. The evaluation harness has to be
    // able to score it with the rest of the app deleted, so the boundary is enforced here
    // rather than left as a one-off review check.
    files: ["src/engine/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "react",
                "react-dom",
                "react/*",
                "**/components/**",
                "**/routes/**",
                "@/components/*",
                "@/routes/*",
                "@/lib/*",
                "@/hooks/*",
                "lucide-react",
                "framer-motion",
                "sonner",
              ],
              message:
                "src/engine must not depend on the app or on React. Its input is plain data passed in by the caller — if it needs a UI type, the boundary is wrong (plan section 4b).",
            },
          ],
        },
      ],
    },
  },
  eslintPluginPrettier,
);
