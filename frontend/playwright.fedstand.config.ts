import { defineConfig, devices } from "@playwright/test";

// Federated stand: two backends (8082 owner A, 8081 proxy B) and two
// frontends (5175 -> A, 5174 -> B) are started by hand before the run.
// This config starts nothing itself.
export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.stand.ts",
	timeout: 120_000,
	expect: { timeout: 20_000 },
	forbidOnly: true,
	workers: 1,
	fullyParallel: false,
	reporter: "list",
	use: {
		locale: "en-US",
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				launchOptions: {
					args: [
						"--use-fake-ui-for-media-stream",
						"--use-fake-device-for-media-stream",
					],
				},
			},
		},
	],
});
