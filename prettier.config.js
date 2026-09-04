/** @type {import("prettier").Config} */
export default {
    semi: true,
    singleQuote: false,
    tabWidth: 4,
    useTabs: false,
    trailingComma: "es5",
    printWidth: 100,
    bracketSpacing: true,
    arrowParens: "always",
    endOfLine: "lf",
    plugins: ["prettier-plugin-svelte"],
    overrides: [
        {
            files: "*.svelte",
            options: {
                parser: "svelte",
            },
        },
        {
            files: ["*.json", "*.yml", "*.yaml"],
            options: {
                tabWidth: 2,
            },
        },
    ],
};
