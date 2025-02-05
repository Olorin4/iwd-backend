import globals from "globals";
import pluginJs from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import jestPlugin from "eslint-plugin-jest";

export default [
    {
        // Global language options
        languageOptions: {
            globals: {
                ...globals.browser, // Browser globals for frontend
                ...globals.node, // Node.js globals for backend
            },
        },
    },
    // Standard recommended configs
    pluginJs.configs.recommended,
    eslintPluginPrettier,
    {
        rules: {
            // General ESLint rules
            "no-unused-vars": "warn",
            "no-undef": "error",
            "arrow-body-style": ["error", "as-needed"],
        },
    },
    // Frontend-specific configuration
    {
        files: ["frontend/**/*.js"],
        languageOptions: {
            globals: globals.browser,
        },
        rules: {
            "no-console": "warn", // Warn for console logs in frontend
        },
    },
    // Backend-specific configuration
    {
        files: ["backend/**/*.js"],
        languageOptions: {
            globals: globals.node,
        },
        rules: {
            "no-console": "off", // Allow console logs in backend
            "global-require": "error", // Enforce `require` at top level
        },
    },
    // Jest-specific configuration
    {
        files: ["tests/**/*"], // Matches Jest test files
        plugins: {
            jest: jestPlugin,
        },
        languageOptions: {
            globals: jestPlugin.environments.globals, // Jest globals
        },
        rules: {
            ...jestPlugin.configs.recommended.rules, // Apply recommended Jest rules
        },
    },
];
