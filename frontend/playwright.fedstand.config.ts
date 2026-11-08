import { defineConfig, devices } from "@playwright/test";

// Federated stand: two independent servers. A owns the calls started by its
// users, B keeps an ephemeral shadow and proxies the signaling to the owner.
// Playwright starts both backends and both dev servers, so the suite runs
// unattended, locally and in CI.
//
// The ports and the data directories differ from the ones of the local e2e
// config: both suites can run on the same machine, and a stale run does not
// leak into the next one. The key directories are separate as well: two
// servers that generate their key pair into the same directory race on the
// first start.
const OWNER_BACKEND = "http://localhost:8082";
const OWNER_FRONTEND = "http://localhost:5175";
const PROXY_BACKEND = "http://localhost:8083";
const PROXY_FRONTEND = "http://localhost:5176";

const OWNER_DATABASE = "/tmp/fastchat-fed-e2e-a.db";
const PROXY_DATABASE = "/tmp/fastchat-fed-e2e-b.db";
const OWNER_UPLOADS = "/tmp/fastchat-fed-e2e-a-uploads";
const PROXY_UPLOADS = "/tmp/fastchat-fed-e2e-b-uploads";
const OWNER_KEYS = "/tmp/fastchat-fed-e2e-a-keys";
const PROXY_KEYS = "/tmp/fastchat-fed-e2e-b-keys";
const OWNER_PUSH_KEYS = "/tmp/fastchat-fed-e2e-a-push";
const PROXY_PUSH_KEYS = "/tmp/fastchat-fed-e2e-b-push";

// process.env carries PATH: the commands find go and npm. The cast keeps the
// unset variables out of the typed record.
const environment = process.env as Record<string, string>;

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.stand.ts",
	timeout: 120_000,
	expect: { timeout: 20_000 },
	forbidOnly: process.env.CI !== undefined,
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
	webServer: [
		{
			command: `rm -f ${OWNER_DATABASE} && go run . --config=../config/dev.yaml`,
			cwd: "../backend",
			url: `${OWNER_BACKEND}/api/config`,
			timeout: 180_000,
			reuseExistingServer: process.env.CI === undefined,
			env: {
				...environment,
				FASTCHAT_HOST: "localhost",
				FASTCHAT_PORT: "8082",
				FASTCHAT_DB_PATH: OWNER_DATABASE,
				FASTCHAT_UPLOADS_DIR: OWNER_UPLOADS,
				FASTCHAT_CORS_ORIGIN: OWNER_FRONTEND,
				FASTCHAT_FEDERATION_KEY_PATH: OWNER_KEYS,
				FASTCHAT_PUSH_KEY_PATH: OWNER_PUSH_KEYS,
			},
		},
		{
			command: `rm -f ${PROXY_DATABASE} && go run . --config=../config/dev.yaml`,
			cwd: "../backend",
			url: `${PROXY_BACKEND}/api/config`,
			timeout: 180_000,
			reuseExistingServer: process.env.CI === undefined,
			env: {
				...environment,
				FASTCHAT_HOST: "localhost",
				FASTCHAT_PORT: "8083",
				FASTCHAT_DB_PATH: PROXY_DATABASE,
				FASTCHAT_UPLOADS_DIR: PROXY_UPLOADS,
				FASTCHAT_CORS_ORIGIN: PROXY_FRONTEND,
				FASTCHAT_FEDERATION_KEY_PATH: PROXY_KEYS,
				FASTCHAT_PUSH_KEY_PATH: PROXY_PUSH_KEYS,
			},
		},
		{
			command: "npx vite --port 5175 --strictPort",
			url: OWNER_FRONTEND,
			timeout: 120_000,
			reuseExistingServer: process.env.CI === undefined,
			env: { ...environment, VITE_API_PROXY: OWNER_BACKEND },
		},
		{
			command: "npx vite --port 5176 --strictPort",
			url: PROXY_FRONTEND,
			timeout: 120_000,
			reuseExistingServer: process.env.CI === undefined,
			env: { ...environment, VITE_API_PROXY: PROXY_BACKEND },
		},
	],
});
