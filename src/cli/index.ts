#!/usr/bin/env node
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import pkg from "../../package.json" with { type: "json" };
import { ConfigError, loadConfig } from "../config/load.ts";
import { createContainer, DEMO_CONNECTION_ID } from "../container.ts";
import { isValidTimeZone } from "../domain/dates.ts";
import { renderComparison } from "../mcp/render.ts";
import { createMcpServer, SERVER_NAME } from "../mcp/server.ts";

const HELP = `${SERVER_NAME} ${pkg.version}: read-only Yandex Metrika MCP server

Usage:
  ${SERVER_NAME} [serve]    Run the MCP server over stdio (what MCP clients start)
  ${SERVER_NAME} doctor     Print an environment report without secrets
  ${SERVER_NAME} demo       Print a sample week-over-week comparison on synthetic data
  ${SERVER_NAME} --version  Print the version

Environment (all optional):
  YM_MCP_LOG_LEVEL  debug | info | warn | error (stderr), default info
  YM_MCP_DEMO       true | false, expose the synthetic conn_demo connection, default true
`;

const MIN_NODE = [22, 13] as const;

function nodeVersionOk(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function serve(): Promise<void> {
  const container = createContainer(loadConfig());
  const handle = serveStdio(() => createMcpServer(container, pkg.version));
  container.logger.info("server started", { version: pkg.version, transport: "stdio" });
  const shutdown = (signal: string) => {
    container.logger.info("server stopping", { signal });
    void handle.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

function doctor(): void {
  const config = loadConfig();
  const checks = [
    {
      check: "node_version",
      ok: nodeVersionOk(),
      detail: `Node ${process.versions.node}, required >= ${MIN_NODE.join(".")}`,
    },
    {
      check: "time_zone_data",
      ok: isValidTimeZone("Asia/Novosibirsk") && isValidTimeZone("Europe/Moscow"),
      detail: "IANA time zones available through Intl",
    },
    {
      check: "yandex_sign_in",
      ok: false,
      detail: "Not available in this preview build; only the demo connection exists.",
    },
  ];
  print(
    JSON.stringify(
      {
        server: SERVER_NAME,
        version: pkg.version,
        platform: `${process.platform}-${process.arch}`,
        config: { log_level: config.logLevel, demo: config.demoEnabled },
        checks,
      },
      null,
      2,
    ),
  );
}

async function demo(): Promise<void> {
  const container = createContainer({ ...loadConfig(), demoEnabled: true, logLevel: "error" });
  const output = await container.comparisons.run({
    connection_id: DEMO_CONNECTION_ID,
    counter_id: "10000001",
    preset: "acquisition",
  });
  print(renderComparison(output));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return print(HELP);
  if (values.version) return print(pkg.version);
  const command = positionals[0] ?? "serve";
  switch (command) {
    case "serve":
      return serve();
    case "doctor":
      return doctor();
    case "demo":
      return demo();
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : "Fatal error; see details above.";
  if (!(error instanceof ConfigError)) console.error(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
