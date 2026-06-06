import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
    // Exclude Pyodide from module transformation — it uses dynamic WASM loading
    // that breaks under Vite/vitest's module rewriting.
    server: {
      deps: {
        external: ["pyodide"],
      },
    },
    // PyodideKernel tests run in separate Node.js processes (forks pool) to avoid
    // Vite's module resolver intercepting Pyodide's internal dynamic imports.
    poolOptions: {
      forks: {
        execArgv: [],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "packages/*/dist/**",
        "packages/*/src/**/*.test.ts",
        // Re-export barrel files — no executable statements, always 0%.
        "packages/*/src/**/index.ts",
        // Type-only definition files.
        "packages/*/src/**/types.ts",
        "packages/core/src/types/**",
        // WasmtimeKernel is a stub that throws — untestable without native addon.
        "packages/core/src/executor/WasmtimeKernel.ts",
        // Example files are not part of the library under test.
        "examples/**",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
