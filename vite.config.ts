import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  server: {
    watch: {
      // Packaging generates HTML and caches beneath the checkout; these are not app pages.
      ignored: [/[/\\](?:\.local-data|releases)(?:[/\\]|$)/],
    },
    host: "127.0.0.1",
    port: 5186,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.BAI_BACKEND_URL || "http://127.0.0.1:8766",
        configure(proxy) {
          proxy.on("proxyReq", (req) => {
            try {
              const folder =
                process.env.BAI_DATA_DIR ||
                resolve(import.meta.dirname, ".local-data/dev");
              req.setHeader(
                "Authorization",
                `Bearer ${readFileSync(resolve(folder, "auth-token"), "utf8").trim()}`,
              );
            } catch {
              /* backend may still be starting */
            }
          });
        },
      },
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "es2022" },
});
