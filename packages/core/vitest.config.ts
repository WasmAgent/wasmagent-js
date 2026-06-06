import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        external: ["pyodide", "@agentkit-js/kernel-pyodide"],
      },
    },
  },
});
