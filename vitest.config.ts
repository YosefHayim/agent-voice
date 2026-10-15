import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    // Smoke tests load Whisper and Supertonic models; the 5 s default is too short for a cold load.
    testTimeout: 120_000,
  },
});
