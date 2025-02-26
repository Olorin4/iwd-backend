// Prettier.config.js, .prettierrc.js, prettier.config.mjs, or .prettierrc.mjs
/**
 * @see https://prettier.io/docs/en/configuration.html
 * @type {import("prettier").Config}
 */

const config = {
        trailingComma: "es5",
        tabWidth: 4,
        printWidth: 80,
        semi: true,
        singleQuote: false,
        quoteProps: "as-needed",
        htmlWhitespaceSensitivity: "ignore", // Avoid collapsing white spaces
        bracketSameLine: true,
        bracketSpacing: true,
};

export default config;
