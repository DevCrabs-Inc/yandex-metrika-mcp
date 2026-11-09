import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type AppConfig, loadConfig } from "../config/load.ts";
import { type Container, createContainer, DEMO_CONNECTION_ID } from "../container.ts";
import { isValidTimeZone } from "../domain/dates.ts";
import { DomainError } from "../domain/errors.ts";
import { OAuthError } from "../infra/auth/oauth.ts";
import { httpRequest } from "../infra/http.ts";
import { renderComparison } from "../mcp/render.ts";
import { createMcpServer } from "../mcp/server.ts";
import { CLIENTS, type ClientName, configPath, launcher, runSetup } from "./setup.ts";
import { openBrowser, print, printErr, promptHidden } from "./terminal.ts";

const MIN_NODE = [22, 13] as const;

export function nodeVersionOk(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

async function withContainer<T>(
  version: string,
  run: (c: Container) => Promise<T>,
  config: AppConfig = loadConfig(),
): Promise<T> {
  const container = await createContainer(config, version);
  try {
    return await run(container);
  } finally {
    await container.close();
  }
}

export async function serve(version: string): Promise<void> {
  const container = await createContainer(loadConfig(), version);
  const handle = serveStdio(() => createMcpServer(container, version));
  container.logger.info("server started", { version, transport: "stdio" });
  const shutdown = (signal: string) => {
    container.logger.info("server stopping", { signal });
    void handle
      .close()
      .then(() => container.close())
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

export async function demo(version: string): Promise<void> {
  await withContainer(
    version,
    async (container) => {
      const output = await container.comparisons.run({
        connection_id: DEMO_CONNECTION_ID,
        counter_id: "10000001",
        preset: "acquisition",
      });
      print(renderComparison(output));
    },
    { ...loadConfig(), demoEnabled: true, logLevel: "error" },
  );
}

export async function doctor(version: string, network: boolean): Promise<void> {
  const config = loadConfig();
  const checks: { check: string; ok: boolean; detail: string }[] = [
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
  ];
  let summary: Record<string, unknown> = {};
  try {
    await withContainer(
      version,
      async (c) => {
        checks.push({ check: "state_database", ok: true, detail: "SQLite state opened" });
        const store = await c.secretStoreKind();
        checks.push({
          check: "secret_store",
          ok: store !== "unavailable",
          detail:
            store === "unavailable"
              ? "No OS credential store. Use YANDEX_METRIKA_TOKEN or YM_MCP_SECRET_STORE=file (unencrypted, user-only)."
              : store === "file"
                ? "Unencrypted file chosen explicitly (YM_MCP_SECRET_STORE=file)."
                : `OS credential store (${store})`,
        });
        checks.push({
          check: "browser_sign_in",
          ok: c.login !== null,
          detail: c.login
            ? "OAuth client configured"
            : "No OAuth client ID; use `auth import-token` or set YM_MCP_CLIENT_ID",
        });
        const records = c.connections.records();
        summary = {
          connections: {
            active: records.filter((r) => r.state === "active").length,
            needs_reconnect: records.filter((r) => r.state === "needs_reconnect").length,
            env_token: config.envToken !== null,
            demo: config.demoEnabled,
          },
          jobs: c.exports.jobsSummary(),
        };
      },
      { ...config, logLevel: "error" },
    );
  } catch (error) {
    checks.push({
      check: "state_database",
      ok: false,
      detail: error instanceof Error ? error.message : "failed",
    });
  }
  if (network) {
    for (const [name, url] of [
      ["network_api", "https://api-metrika.yandex.net/"],
      ["network_oauth", "https://oauth.yandex.ru/"],
    ] as const) {
      try {
        const res = await httpRequest((i, init) => fetch(i, init), {
          method: "GET",
          url,
          headers: {},
          timeoutMs: 8000,
          maxBytes: 64 * 1024,
        }).catch(async (e: unknown) => {
          // A redirect still proves the host answered.
          if (e instanceof Error && e.name === "HttpNetworkError") throw e;
          return { status: 0 };
        });
        checks.push({
          check: name,
          ok: true,
          detail: `${url} answered (HTTP ${res.status || "redirect"})`,
        });
      } catch {
        checks.push({ check: name, ok: false, detail: `${url} is not reachable` });
      }
    }
  }
  print(
    JSON.stringify(
      {
        server: "yandex-metrika-mcp",
        version,
        platform: `${process.platform}-${process.arch}`,
        config: {
          log_level: config.logLevel,
          secret_store: config.secretStore,
          api_lang: config.apiLang,
          privacy: config.privacy,
          auto_resume: config.autoResume,
          custom_data_dir: process.env["YM_MCP_DATA_DIR"] !== undefined,
        },
        ...summary,
        checks,
        note: "No tokens, counter names, queries or report data are included. Review before sharing.",
      },
      null,
      2,
    ),
  );
}

export async function authLogin(
  version: string,
  options: { alias: string | null; reconnect: string | null; manual: boolean; browser: boolean },
): Promise<void> {
  await withContainer(version, async (c) => {
    const login = c.browserLogin;
    if (!login) {
      printErr(
        "Browser sign-in is not configured: set YM_MCP_CLIENT_ID, or use `auth import-token`.",
      );
      process.exitCode = 1;
      return;
    }
    const started = await login.server.start(options.alias, options.reconnect);
    const attempt = login.server.attempt(started.handle);
    if (!attempt) throw new Error("sign-in attempt vanished");
    if (options.manual) {
      print(
        "Open this URL, sign in, then copy the value of code= from the address bar of the final page:",
      );
      print(login.server.authorizeUrlFor(attempt));
      const code = await promptHidden("Code: ");
      try {
        const result = await login.complete(attempt, code);
        print(`Connected: ${result.connectionId} (${result.counters.length} counters available).`);
      } catch (error) {
        printErr(
          error instanceof OAuthError || error instanceof DomainError
            ? error.message
            : "Sign-in failed.",
        );
        process.exitCode = 1;
      }
      return;
    }
    print(
      `Open this page to sign in with Yandex (valid until ${started.expiresAt.toISOString()}):`,
    );
    print(started.url);
    if (options.browser) openBrowser(started.url);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const current = login.server.attempt(started.handle);
      if (!current || current.status === "expired") {
        printErr("The sign-in expired.");
        process.exitCode = 1;
        return;
      }
      if (current.status === "failed") {
        printErr(current.error ?? "Sign-in failed.");
        process.exitCode = 1;
        return;
      }
      if (current.status === "completed") {
        print(`Connected: ${current.connectionId ?? "?"}.`);
        return;
      }
    }
  });
}

export async function authImportToken(version: string, alias: string | null): Promise<void> {
  const token = await promptHidden("Paste the OAuth token (input is hidden): ");
  if (token.length < 10) {
    printErr("That does not look like a token; nothing was saved.");
    process.exitCode = 1;
    return;
  }
  await withContainer(version, async (c) => {
    try {
      const saved = await c.connections.save(
        { access_token: token, refresh_token: null, expires_at: null },
        { alias, kind: "token", reconnectId: null, validate: true },
      );
      print(`Connected: ${saved.connectionId} (${saved.counters.length} counters available).`);
    } catch (error) {
      printErr(
        error instanceof DomainError
          ? `${error.message}${error.nextAction ? `\n${error.nextAction}` : ""}`
          : "Import failed.",
      );
      process.exitCode = 1;
    }
  });
}

export async function authList(version: string): Promise<void> {
  await withContainer(version, async (c) => {
    const rows = [
      ...c.connections.staticConnections().map((s) => `${s.id}\t${s.kind}\tactive\t${s.alias}`),
      ...c.connections
        .records()
        .map(
          (r) =>
            `${r.id}\t${r.kind}\t${r.state}\t${r.alias}\t${r.allowed_counters ? `counters: ${r.allowed_counters.join(",")}` : "all counters"}`,
        ),
    ];
    print(rows.length === 0 ? "No connections." : rows.join("\n"));
  });
}

export async function authLogout(version: string, connectionId: string): Promise<void> {
  await withContainer(version, async (c) => {
    const result = await c.connections.disconnect(connectionId);
    print(
      `Disconnected ${connectionId}: token ${result.tokenDeleted ? "deleted" : "NOT deleted"}, ${result.jobsCancelled} export(s) cancelled.`,
    );
    print(
      "To revoke the app's access in Yandex as well, remove it in your Yandex ID account settings.",
    );
  });
}

export async function authAllow(
  version: string,
  connectionId: string,
  counters: readonly string[],
): Promise<void> {
  if (counters.some((id) => !/^\d{1,12}$/.test(id))) {
    printErr("Counter IDs must be numeric.");
    process.exitCode = 1;
    return;
  }
  await withContainer(version, async (c) => {
    c.connections.setAllowlist(connectionId, counters.length > 0 ? counters : null);
    print(
      counters.length > 0
        ? `${connectionId} is limited to: ${counters.join(", ")}`
        : `${connectionId} can use all accessible counters.`,
    );
  });
}

export function setup(options: {
  client: string;
  launcher: "npx" | "node";
  dryRun: boolean;
  remove: boolean;
}): void {
  if (!(CLIENTS as readonly string[]).includes(options.client)) {
    printErr(`Unknown client. Choose one of: ${CLIENTS.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const client = options.client as ClientName;
  const entry = launcher(
    options.launcher,
    process.platform,
    process.argv[1] ?? "",
    process.execPath,
  );
  const result = runSetup({
    client,
    entry,
    remove: options.remove,
    dryRun: options.dryRun,
    path: configPath(client, process.platform, process.env),
    now: new Date(),
  });
  if (result.path === null) {
    print(`Run this command to ${options.remove ? "remove" : "add"} the server in Claude Code:`);
    print(result.content);
    return;
  }
  if (!result.written) {
    print(`Would write ${result.path}:\n${result.content}`);
    return;
  }
  print(
    `Updated ${result.path}${result.backup ? ` (backup: ${result.backup})` : ""}. Restart the client to load the server.`,
  );
}

export async function jobs(version: string, clean: boolean): Promise<void> {
  await withContainer(version, async (c) => {
    if (clean) {
      await c.exports.cleanup();
      print("Expired exports and finished jobs past retention were removed.");
      return;
    }
    const list = c.exports.listJobs();
    if (list.length === 0) return print("No export jobs.");
    for (const job of list) {
      const file = job.artifacts[0]?.file_path ?? "";
      print(
        `${job.job_id}\t${job.state}\t${job.connection_id}\tcounter ${job.query.counter.id}\t${job.query.period.start}..${job.query.period.end}\t${file}`,
      );
    }
  });
}
