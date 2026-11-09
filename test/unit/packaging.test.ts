import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { TOOL_NAMES } from "../../src/mcp/tools.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("release metadata", () => {
  it("MCPB manifest lists exactly the registered tools", () => {
    const manifest = JSON.parse(
      read("packaging/mcpb/manifest.template.json").replace("__VERSION__", "0.0.0"),
    );
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      [...TOOL_NAMES].sort(),
    );
    expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/dist/cli.js"]);
  });

  it("server.json matches package.json", () => {
    const server = JSON.parse(read("server.json"));
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0]).toMatchObject({
      registryType: "npm",
      identifier: pkg.name,
      version: pkg.version,
    });
  });

  it("documents every registered tool and no tool that does not exist", () => {
    const registered = new Set<string>(TOOL_NAMES);
    for (const path of ["README.md", "docs/ru/tools.md"]) {
      const text = read(path);
      for (const name of TOOL_NAMES) expect(text, `${path} misses ${name}`).toContain(name);
    }
    const docs = [
      "README.md",
      "README.ru.md",
      "llms-install.md",
      ...readdirSync(new URL("../../docs/ru/", import.meta.url)).map((f) => `docs/ru/${f}`),
    ];
    for (const path of docs) {
      const mentioned = read(path).match(/\bmetrika_[a-z_]+\b/g) ?? [];
      for (const name of mentioned) expect(registered.has(name), `${path}: ${name}`).toBe(true);
    }
  });

  it("ships no client secret", () => {
    const sources = ["src/config/oauth-app.ts", "src/infra/auth/oauth.ts"].map(read).join("\n");
    expect(sources).not.toMatch(/client_secret\s*[:=]/);
  });
});
