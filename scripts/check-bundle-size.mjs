// Fails when the single-file bundle grows unexpectedly: npx downloads and parses it on
// every cold start. Raise the limit on purpose, in the same change that needs it.
import { statSync } from "node:fs";

const MAX_BUNDLE_BYTES = 1_500_000; // 1.19 MB on 2026-11-09 plus about 25 %
const path = new URL("../dist/cli.js", import.meta.url);
const size = statSync(path).size;
if (size > MAX_BUNDLE_BYTES) {
  console.error(`dist/cli.js is ${size} bytes, over the limit of ${MAX_BUNDLE_BYTES}.`);
  process.exit(1);
}
process.stdout.write(`dist/cli.js: ${size} of ${MAX_BUNDLE_BYTES} bytes\n`);
