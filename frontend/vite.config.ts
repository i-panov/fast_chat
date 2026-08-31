import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		react(),
		tailwindcss(),
		VitePWA({
			strategies: "injectManifest",
			srcDir: "src",
			filename: "sw.ts",
			includeAssets: ["favicon.ico"],
			manifest: {
				name: "Fast Chat",
				short_name: "FastChat",
				description: "Real-time messaging app",
				theme_color: "#1a1b1e",
				background_color: "#1a1b1e",
				display: "standalone",
				icons: [
					{
						src: "logo192.png",
						sizes: "192x192",
						type: "image/png",
					},
					{
						src: "logo512.png",
						sizes: "512x512",
						type: "image/png",
					},
				],
			},
			devOptions: {
				enabled: false,
			},
		}),
	],
	server: {
		proxy: {
			"/api": process.env.VITE_API_PROXY ?? "http://localhost:8080",
		},
	},
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			reportsDirectory: "../coverage/frontend",
			include: ["src/**"],
			exclude: ["src/routeTree.gen.ts", "src/sw.ts", "src/main.tsx"],
		},
	},
});
