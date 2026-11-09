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
  // One self-contained file for a fast `npx` cold start. The keychain module
  // ships native binaries per platform, so it stays an external dependency.
  deps: {
    alwaysBundle: [/^(?!@napi-rs\/keyring)/],
    neverBundle: ["@napi-rs/keyring"],
    onlyBundle: false,
  },
});
