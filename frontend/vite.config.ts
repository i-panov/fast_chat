import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  server: {
    proxy: {
      "/api": process.env.VITE_API_PROXY ?? "http://localhost:8080",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
