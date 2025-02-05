import globals from "globals";
import pluginJs from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import jestPlugin from "eslint-plugin-jest";

export default [
    {
        // Global language options
        languageOptions: {
            globals: {
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
    // Backend-specific configuration (Root directory files)
    {
        files: ["*.js"], // Applies ESLint rules to all JavaScript files in the root
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
        files: ["tests/**/*.js"], // Matches Jest test files
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
