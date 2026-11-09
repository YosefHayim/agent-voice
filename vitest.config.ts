import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolves "#src/*" to src/ (see package.json "imports"), the same as tsx run with --conditions=source.
  resolve: { conditions: ["source"] },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    // Smoke tests load Whisper and Supertonic models; the 5 s default is too short for a cold load.
    testTimeout: 120_000,
  },
});
