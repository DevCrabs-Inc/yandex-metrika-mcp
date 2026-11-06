import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

describe("stdio server (T16)", () => {
  it("starts without any token and keeps stdout for protocol messages only", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { PATH: process.env["PATH"] ?? "", YM_MCP_LOG_LEVEL: "debug" },
      stderr: "pipe",
    });
    const stderr: string[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    const client = new Client({ name: "e2e", version: "1.0.0" });
    // Any non-JSON-RPC line on stdout would break the client during connect.
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const status = await client.callTool({ name: "metrika_status", arguments: {} });
    expect(status.isError).not.toBe(true);
    await client.close();
    expect(stderr.join("")).toMatch(/"msg":"server started"/);
  });
});
