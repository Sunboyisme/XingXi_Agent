import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/testSetup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
