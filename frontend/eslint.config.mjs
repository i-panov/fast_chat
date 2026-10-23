// @ts-check

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

export default defineConfig([
	globalIgnores([
		"**/node_modules/**",
		"**/dist/**",
		"**/dev-dist/**",
		"**/routeTree.gen.ts",
		"**/coverage/**",
	]),

	// Plain JS/ESM files (postcss.config.mjs): core rules only.
	js.configs.recommended,

	{
		files: ["**/*.{ts,tsx}"],
		extends: [
			tseslint.configs.recommendedTypeChecked,
			react.configs.flat.recommended,
			react.configs.flat["jsx-runtime"],
			reactHooks.configs.flat.recommended,
		],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
			globals: globals.browser,
		},
		plugins: {
			react,
			"react-hooks": reactHooks,
			sonarjs: sonarjs.configs.recommended.plugins.sonarjs,
		},
		settings: {
			react: {
				version: "detect",
			},
		},
		rules: {
			// TypeScript covers prop validation statically; the runtime
			// prop-types checks add noise without value here.
			"react/prop-types": "off",
			// "_" prefixed bindings are the codebase's discard convention
			// (also for rest-sibling destructuring omissions).
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					ignoreRestSiblings: true,
				},
			],
			// React-Compiler-era rule: flags the idiomatic "reset derived
			// state when input/open changes" pattern that the modals and
			// media hooks rely on. Kept as a warning so new code follows
			// the recommended key/derive-in-render patterns without
			// blocking the existing, tested implementations.
			"react-hooks/set-state-in-effect": "warn",
			// Copy-paste detection.
			"sonarjs/no-identical-functions": "error",
			"sonarjs/no-duplicate-string": "error",
			// Oversized code: file / function size and complexity.
			"max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
			"max-lines-per-function": ["error", { max: 200, skipBlankLines: true, skipComments: true }],
			"max-statements": ["error", 65],
			complexity: ["error", 30],
		},
	},

	// Test files repeat fixture strings by design; mirror the backend, which
	// excludes *_test.go from dupl and funlen.
	{
		files: [
			"**/*.{test,spec}.{ts,tsx}",
			"**/*.e2e.ts",
			"**/__tests__/**/*.{ts,tsx}",
		],
		rules: {
			"sonarjs/no-duplicate-string": "off",
			"max-lines-per-function": "off",
		},
	},

	// Node-side config/setup files are not part of the browser bundle.
	{
		files: [
			"vite.config.ts",
			"vitest.setup.ts",
			"postcss.config.mjs",
			"playwright.config.ts",
		],
		languageOptions: {
			globals: globals.node,
		},
	},
]);