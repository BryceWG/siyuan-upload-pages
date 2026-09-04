import { fileURLToPath } from "node:url";

import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";

const gitignorePath = fileURLToPath(new URL(".gitignore", import.meta.url));

export default ts.config(
    includeIgnoreFile(gitignorePath),
    js.configs.recommended,
    ts.configs.recommended,
    svelte.configs.recommended,
    prettier,
    svelte.configs.prettier,
    {
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            // The plugin predates strict TypeScript; tsc is already `strict: false`.
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            // Settings copy may contain light HTML from i18n strings.
            "svelte/no-at-html-tags": "off",
            // Match svelte.config.js: SiYuan's settings UI is mouse-first.
            "svelte/a11y-click-events-have-key-events": "off",
            "svelte/a11y-no-static-element-interactions": "off",
            "svelte/a11y-no-noninteractive-element-interactions": "off",
        },
    },
    {
        files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
        languageOptions: {
            parserOptions: {
                extraFileExtensions: [".svelte"],
                parser: ts.parser,
            },
        },
        rules: {
            // Global `.d.ts` types (e.g. ISettingItem) are not runtime values.
            "no-undef": "off",
        },
    },
    {
        ignores: ["**/*.tsbuildinfo"],
    }
);
