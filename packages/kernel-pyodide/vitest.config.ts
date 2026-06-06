import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Pyodide uses dynamic WASM loading — exclude Vite module rewriting.
    server: {
      deps: {
        external: ["pyodide"],
      },
    },
  },
});
