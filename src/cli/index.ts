#!/usr/bin/env node
import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { ConfigError } from "../config/load.ts";
import { DomainError } from "../domain/errors.ts";
import { DatabaseTooNewError } from "../infra/storage/sqlite-store.ts";
import {
  authAllow,
  authImportToken,
  authList,
  authLogin,
  authLogout,
  demo,
  doctor,
  jobs,
  serve,
  setup,
} from "./commands.ts";
import { CLIENTS } from "./setup.ts";
import { print, printErr } from "./terminal.ts";

// node:sqlite still prints an ExperimentalWarning on Node 22; it is noise for MCP clients.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const NAME = "yandex-metrika-mcp";
const HELP = `${NAME} ${pkg.version}: read-only Yandex Metrika MCP server

Usage:
  ${NAME} [serve]                       Run the MCP server over stdio (what MCP clients start)
  ${NAME} setup --client <name>         Add the server to a client config (${CLIENTS.join(", ")})
        [--launcher npx|node] [--dry-run] [--remove]
  ${NAME} auth login [--alias A]        Sign in with Yandex in the browser
        [--reconnect CONN_ID] [--manual] [--no-browser]
  ${NAME} auth import-token [--alias A] Save an existing OAuth token (hidden prompt or stdin)
  ${NAME} auth list                     List connections
  ${NAME} auth allow CONN_ID [COUNTER_ID ...]  Limit a connection to counters (none = all)
  ${NAME} auth logout CONN_ID           Disconnect and delete the stored token
  ${NAME} jobs [clean]                  List export jobs, or remove expired exports
  ${NAME} doctor [--network]            Environment report without secrets
  ${NAME} demo                          Sample comparison on synthetic data
  ${NAME} --version

Settings are environment variables; see docs/ru/configuration.md.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      alias: { type: "string" },
      reconnect: { type: "string" },
      manual: { type: "boolean" },
      "no-browser": { type: "boolean" },
      client: { type: "string" },
      launcher: { type: "string" },
      "dry-run": { type: "boolean" },
      remove: { type: "boolean" },
      network: { type: "boolean" },
    },
  });
  const version = pkg.version;
  if (values.help) return print(HELP);
  if (values.version) return print(version);
  const [command = "serve", sub, ...rest] = positionals;
  switch (command) {
    case "serve":
      return serve(version);
    case "doctor":
      return doctor(version, values.network === true);
    case "demo":
      return demo(version);
    case "setup":
      return setup({
        client: values.client ?? "",
        launcher: values.launcher === "node" ? "node" : "npx",
        dryRun: values["dry-run"] === true,
        remove: values.remove === true,
      });
    case "jobs":
      return jobs(version, sub === "clean");
    case "auth":
      switch (sub) {
        case "login":
          return authLogin(version, {
            alias: values.alias ?? null,
            reconnect: values.reconnect ?? null,
            manual: values.manual === true,
            browser: values["no-browser"] !== true,
          });
        case "import-token":
          return authImportToken(version, values.alias ?? null);
        case "list":
          return authList(version);
        case "logout":
          if (!rest[0]) break;
          return authLogout(version, rest[0]);
        case "allow":
          if (!rest[0]) break;
          return authAllow(version, rest[0], rest.slice(1));
      }
      break;
  }
  printErr(`Unknown command.\n\n${HELP}`);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  if (
    error instanceof ConfigError ||
    error instanceof DatabaseTooNewError ||
    error instanceof DomainError
  ) {
    printErr(error.message);
  } else {
    console.error(error);
    printErr("Fatal error; see details above.");
  }
  process.exitCode = 1;
});
