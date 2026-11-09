import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");

function files(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "node_modules" || name === "__toolsnaps__" ? [] : files(path, extensions);
    }
    return extensions.some((ext) => name.endsWith(ext)) ? [path] : [];
  });
}

/** `src/infra/yandex/client.ts` → `infra`; top-level files are their own layer. */
function layerOf(path: string): string {
  const parts = relative(SRC, path).split(sep);
  return parts.length === 1 ? (parts[0] ?? "").replace(/\.ts$/, "") : (parts[0] ?? "");
}

// Who may import whom (AGENTS.md "Layout and layering"). cli and container are the
// entry point and the composition root, so they may import anything inside src.
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  domain: [],
  app: ["domain"],
  demo: ["app", "domain"],
  infra: ["app", "domain"],
  config: ["infra"],
  mcp: ["app", "domain", "container", "infra/log"],
};

// Static imports and re-exports, including side-effect imports without `from`.
const IMPORT = /^\s*(?:import|export)\b[^"';]*?(?:from\s+)?["'](\.[^"']+)["']/gm;

describe("layering", () => {
  it("keeps every import inside the allowed direction", () => {
    const violations: string[] = [];
    for (const file of files(SRC, [".ts"])) {
      const from = layerOf(file);
      const allowed = ALLOWED[from];
      if (allowed === undefined) continue;
      for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const target = resolve(dirname(file), match[1] ?? "");
        const to = layerOf(target);
        if (to === from) continue;
        const sub = relative(SRC, target).split(sep).slice(0, 2).join("/");
        if (!allowed.includes(to) && !allowed.includes(sub)) {
          violations.push(`${relative(ROOT, file)} → ${relative(ROOT, target)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("source hygiene", () => {
  // Invisible format characters and bidi controls can make code or docs read
  // differently from what they do ("Trojan Source"); tests write them as escapes.
  const HIDDEN = /[\p{Cf}\p{Zl}\p{Zp}\p{Co}]/u;
  // ZWJ joins emoji sequences in docs.
  const ALLOWED_HIDDEN = new Set([String.fromCodePoint(0x200d)]);

  it("has no invisible or bidi characters in code, tests and docs", () => {
    const roots = ["src", "test", "scripts", "docs", "packaging"].map((d) => join(ROOT, d));
    const top = readdirSync(ROOT)
      .filter((n) => /\.(md|json|ts|mjs|yml)$/.test(n))
      .map((n) => join(ROOT, n));
    const checked = [
      ...top,
      ...roots.flatMap((d) => files(d, [".ts", ".mjs", ".md", ".json", ".yml"])),
    ];
    const found: string[] = [];
    for (const file of checked) {
      const text = readFileSync(file, "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        const char = [...line].find((c) => HIDDEN.test(c) && !ALLOWED_HIDDEN.has(c));
        if (char !== undefined) {
          const code = char.codePointAt(0)?.toString(16).padStart(4, "0");
          found.push(`${relative(ROOT, file)}:${index + 1} U+${code}`);
        }
      }
    }
    expect(checked.length).toBeGreaterThan(50);
    expect(found).toEqual([]);
  });
});
