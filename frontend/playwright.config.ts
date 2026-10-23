import { defineConfig, devices } from "@playwright/test";

// The end-to-end test runs against the development build: the pages reach the
// API through the proxy of the dev server, so a single origin serves both the
// interface and the backend.
//
// The servers of the test take ports and a database of their own: a running
// development instance keeps its data, and the test starts from scratch.
const FRONTEND = "http://localhost:5174";
const BACKEND = "http://localhost:8081";
const DATABASE = "/tmp/fastchat-e2e.db";
const UPLOADS = "/tmp/fastchat-e2e-uploads";

// process.env carries PATH: the commands find go and npm. The cast keeps the
// unset variables out of the typed record.
const environment = process.env as Record<string, string>;

export default defineConfig({
	testDir: "./e2e",
	// The tests carry the ".e2e" suffix: the unit tests of the interface use
	// the ".test" one, and the two runners must not collect each other's
	// files.
	testMatch: "**/*.e2e.ts",
	// The call waits for the media of two browsers: the default of five
	// seconds is not enough for the connection to be established.
	timeout: 60_000,
	expect: { timeout: 15_000 },
	// A test left as the only one of the file would silently skip the rest of
	// the suite.
	forbidOnly: process.env.CI !== undefined,
	// The tests share one backend: they must not run at the same time.
	workers: 1,
	fullyParallel: false,
	reporter: "list",
	use: {
		baseURL: FRONTEND,
		// The selectors of the test are the names of the English translation.
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
						// The browser takes the place of the camera and the
						// microphone: it answers with a test pattern and grants
						// the permission without asking.
						"--use-fake-ui-for-media-stream",
						"--use-fake-device-for-media-stream",
					],
				},
			},
		},
	],
	webServer: [
		{
			command: `rm -f ${DATABASE} && go run . --config=../config/dev.yaml`,
			cwd: "../backend",
			url: `${BACKEND}/api/config`,
			timeout: 180_000,
			reuseExistingServer: process.env.CI === undefined,
			env: {
				...environment,
				FASTCHAT_HOST: "localhost",
				FASTCHAT_PORT: "8081",
				FASTCHAT_DB_PATH: DATABASE,
				FASTCHAT_UPLOADS_DIR: UPLOADS,
				FASTCHAT_CORS_ORIGIN: FRONTEND,
			},
		},
		{
			command: "npx vite --port 5174 --strictPort",
			url: FRONTEND,
			timeout: 120_000,
			reuseExistingServer: process.env.CI === undefined,
			env: { ...environment, VITE_API_PROXY: BACKEND },
		},
	],
});
