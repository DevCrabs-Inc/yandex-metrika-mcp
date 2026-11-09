import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { tempDir } from "../helpers.ts";

// YM_MCP_E2E_BIN runs the same checks against an installed package (CI: the packed
// tarball) instead of the sources.
const entry =
  process.env["YM_MCP_E2E_BIN"] ??
  fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

describe("stdio server (T16)", () => {
  it("starts without any token and keeps stdout for protocol messages only", async () => {
    const dir = tempDir();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        PATH: process.env["PATH"] ?? "",
        YM_MCP_LOG_LEVEL: "debug",
        YM_MCP_DATA_DIR: dir.path,
        YM_MCP_SECRET_STORE: "file",
      },
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
    const { tools: listed } = await client.listTools();
    expect(listed).toHaveLength(13);
    await client.close();
    dir.remove();
    const log = stderr.join("");
    expect(log).toMatch(/"msg":"server started"/);
    expect(log).not.toMatch(/ExperimentalWarning/);
  });
});

describe("stdio export flow (EXP-01)", () => {
  it("exports demo data to a file in a real server process", async () => {
    const dir = tempDir();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        PATH: process.env["PATH"] ?? "",
        YM_MCP_DATA_DIR: dir.path,
        YM_MCP_SECRET_STORE: "file",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transport);
    const created = await client.callTool({
      name: "metrika_export_report",
      arguments: {
        connection_id: "conn_demo",
        counter_id: "10000001",
        preset: "landing_pages",
        format: "json",
        idempotency_key: "e2e-key-0001",
      },
    });
    const jobId = (created.structuredContent as { job_id: string }).job_id;
    let job: { state: string; artifacts: { artifact_id: string; rows: number }[] } = {
      state: "queued",
      artifacts: [],
    };
    for (let i = 0; i < 100 && job.state !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const polled = await client.callTool({
        name: "metrika_get_job",
        arguments: { connection_id: "conn_demo", job_id: jobId },
      });
      job = polled.structuredContent as typeof job;
    }
    expect(job.state).toBe("completed");
    const artifact = job.artifacts[0];
    expect(artifact?.rows).toBe(6);
    const chunk = await client.callTool({
      name: "metrika_read_artifact",
      arguments: { connection_id: "conn_demo", artifact_id: artifact?.artifact_id },
    });
    const text = (chunk.structuredContent as { text: string; eof: boolean }).text;
    expect(JSON.parse(text).rows).toHaveLength(6);
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain(
      `metrika://artifacts/${artifact?.artifact_id}`,
    );
    await client.close();
    dir.remove();
  });
});
