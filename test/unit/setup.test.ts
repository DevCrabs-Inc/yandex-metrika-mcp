import { describe, expect, it } from "vitest";
import { cutChunk } from "../../src/app/export/artifact-service.ts";
import { launcher, SetupError, updateCodexConfig, updateJsonConfig } from "../../src/cli/setup.ts";

const entry = { command: "npx", args: ["-y", "@dev-crabs/yandex-metrika-mcp"] };

describe("client setup (UX-04)", () => {
  it("adds the server and keeps every other setting", () => {
    const current = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } });
    const next = JSON.parse(updateJsonConfig(current, "claude-desktop", entry, false));
    expect(next.theme).toBe("dark");
    expect(next.mcpServers.other).toEqual({ command: "x" });
    expect(next.mcpServers["yandex-metrika"]).toEqual(entry);
  });

  it("uses the VS Code servers shape and supports removal", () => {
    const added = updateJsonConfig(null, "vscode", entry, false);
    expect(JSON.parse(added).servers["yandex-metrika"]).toMatchObject({
      type: "stdio",
      command: "npx",
    });
    expect(JSON.parse(updateJsonConfig(added, "vscode", entry, true)).servers).toEqual({});
  });

  it("never overwrites a config it cannot parse", () => {
    expect(() => updateJsonConfig("{ broken", "cursor", entry, false)).toThrow(SetupError);
  });

  it("edits only its own table in Codex config.toml", () => {
    const current = 'model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n';
    const added = updateCodexConfig(current, entry, false);
    expect(added).toContain(
      '[mcp_servers.yandex-metrika]\ncommand = "npx"\nargs = ["-y", "@dev-crabs/yandex-metrika-mcp"]',
    );
    expect(updateCodexConfig(added, entry, false).match(/yandex-metrika\]/g)).toHaveLength(1);
    expect(updateCodexConfig(added, entry, true)).toBe(current);
  });

  it("wraps npx in cmd on Windows", () => {
    expect(launcher("npx", "win32", "", "")).toEqual({
      command: "cmd",
      args: ["/c", "npx", "-y", "@dev-crabs/yandex-metrika-mcp"],
    });
    expect(launcher("node", "linux", "/opt/cli.js", "/usr/bin/node")).toEqual({
      command: "/usr/bin/node",
      args: ["/opt/cli.js"],
    });
  });
});

describe("artifact chunks", () => {
  it("never splits a UTF-8 character or a row", () => {
    const text = Buffer.from("строка 1\nстрока 2", "utf8");
    expect(cutChunk(text.subarray(0, 20), false).toString()).toBe("строка 1\n");
    const noNewline = Buffer.from("ёёё", "utf8");
    expect(cutChunk(noNewline.subarray(0, 5), false).toString()).toBe("ёё");
    expect(cutChunk(noNewline.subarray(0, 4), false).toString()).toBe("ёё");
    expect(cutChunk(Buffer.from("ab😀", "utf8").subarray(0, 5), false).toString()).toBe("ab");
    expect(cutChunk(text, true)).toBe(text);
  });
});
