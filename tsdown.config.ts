import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  fixedExtension: false,
  dts: false,
  clean: true,
  sourcemap: true,
  // One self-contained file: fast `npx` cold start and a simple MCPB bundle.
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
});
