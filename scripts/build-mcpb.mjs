// Builds a universal .mcpb bundle: the single-file server plus the keychain
// module with its prebuilt binaries for every supported platform.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = join(root, "build", "mcpb");
const out = join(root, "build", `yandex-metrika-mcp-${pkg.version}.mcpb`);
const keyring = pkg.dependencies["@napi-rs/keyring"];
const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "win32-x64-msvc",
  "win32-arm64-msvc",
  "linux-x64-gnu",
  "linux-arm64-gnu",
];

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });
cpSync(join(root, "dist", "cli.js"), join(stage, "dist", "cli.js"));
cpSync(join(root, "assets", "logo-512.png"), join(stage, "icon.png"));
for (const file of ["README.md", "README.ru.md", "LICENSE"])
  cpSync(join(root, file), join(stage, file));
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    { name: "yandex-metrika-mcp-bundle", version: pkg.version, type: "module", private: true },
    null,
    2,
  ),
);
const manifest = readFileSync(
  join(root, "packaging", "mcpb", "manifest.template.json"),
  "utf8",
).replace("__VERSION__", pkg.version);
writeFileSync(join(stage, "manifest.json"), manifest);

const packages = [
  `@napi-rs/keyring@${keyring}`,
  ...platforms.map((p) => `@napi-rs/keyring-${p}@${keyring}`),
];
// --force installs binaries for other platforms too; the loader picks the right one at runtime.
execFileSync(
  "npm",
  ["install", "--force", "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund", ...packages],
  {
    cwd: stage,
    stdio: "inherit",
  },
);
execFileSync("npx", ["-y", "@anthropic-ai/mcpb@2.1.2", "pack", stage, out], { stdio: "inherit" });
process.stdout.write(`Built ${out}\n`);
