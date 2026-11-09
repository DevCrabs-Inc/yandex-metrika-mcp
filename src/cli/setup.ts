import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PACKAGE_NAME = "@devcrabs/yandex-metrika-mcp";
export const SERVER_KEY = "yandex-metrika";

export const CLIENTS = [
  "claude-desktop",
  "claude-code",
  "cursor",
  "vscode",
  "windsurf",
  "codex",
] as const;
export type ClientName = (typeof CLIENTS)[number];

export interface Launcher {
  readonly command: string;
  readonly args: readonly string[];
}

export function launcher(
  kind: "npx" | "node",
  platform: NodeJS.Platform,
  script: string,
  nodePath: string,
): Launcher {
  if (kind === "node") return { command: nodePath, args: [script] };
  // Clients spawn without a shell; on Windows npx is a .cmd script that needs cmd.exe.
  return platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", PACKAGE_NAME] }
    : { command: "npx", args: ["-y", PACKAGE_NAME] };
}

export function configPath(
  client: ClientName,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home = homedir(),
): string | null {
  const appData = env["APPDATA"] ?? join(home, "AppData", "Roaming");
  switch (client) {
    case "claude-desktop":
      if (platform === "darwin")
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (platform === "win32") return join(appData, "Claude", "claude_desktop_config.json");
      return join(
        env["XDG_CONFIG_HOME"] ?? join(home, ".config"),
        "Claude",
        "claude_desktop_config.json",
      );
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "windsurf":
      return join(home, ".codeium", "windsurf", "mcp_config.json");
    case "vscode":
      if (platform === "darwin")
        return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
      if (platform === "win32") return join(appData, "Code", "User", "mcp.json");
      return join(env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "Code", "User", "mcp.json");
    case "codex":
      return join(env["CODEX_HOME"] ?? join(home, ".codex"), "config.toml");
    case "claude-code":
      return null;
  }
}

export class SetupError extends Error {
  override readonly name = "SetupError";
}

/** Adds or removes our entry in a JSON client config, keeping every other setting. */
export function updateJsonConfig(
  current: string | null,
  client: ClientName,
  entry: Launcher,
  remove: boolean,
): string {
  let config: Record<string, unknown> = {};
  if (current !== null && current.trim() !== "") {
    try {
      config = JSON.parse(current) as Record<string, unknown>;
    } catch {
      throw new SetupError(
        "The existing config is not valid JSON; fix it first, nothing was changed.",
      );
    }
  }
  const key = client === "vscode" ? "servers" : "mcpServers";
  const servers = { ...((config[key] as Record<string, unknown> | undefined) ?? {}) };
  if (remove) delete servers[SERVER_KEY];
  else {
    servers[SERVER_KEY] =
      client === "vscode"
        ? { type: "stdio", command: entry.command, args: [...entry.args] }
        : { command: entry.command, args: [...entry.args] };
  }
  return `${JSON.stringify({ ...config, [key]: servers }, null, 2)}\n`;
}

const tomlString = (value: string): string => JSON.stringify(value);

/** Adds or removes our [mcp_servers.yandex-metrika] table in Codex config.toml. */
export function updateCodexConfig(
  current: string | null,
  entry: Launcher,
  remove: boolean,
): string {
  const header = `[mcp_servers.${SERVER_KEY}]`;
  const lines = (current ?? "").split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !(lines[end] ?? "").trim().startsWith("[")) end += 1;
    lines.splice(start, end - start);
  }
  let text = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  if (!remove) {
    const block = [
      header,
      `command = ${tomlString(entry.command)}`,
      `args = [${entry.args.map(tomlString).join(", ")}]`,
    ].join("\n");
    text = text === "" ? block : `${text}\n\n${block}`;
  }
  return `${text}\n`;
}

export interface SetupResult {
  readonly path: string | null;
  readonly backup: string | null;
  readonly content: string;
  readonly written: boolean;
}

export function runSetup(options: {
  readonly client: ClientName;
  readonly entry: Launcher;
  readonly remove: boolean;
  readonly dryRun: boolean;
  readonly path: string | null;
  readonly now: Date;
}): SetupResult {
  const { client, entry, remove, dryRun, path } = options;
  if (path === null) {
    const command = remove
      ? `claude mcp remove --scope user ${SERVER_KEY}`
      : `claude mcp add --scope user ${SERVER_KEY} -- ${[entry.command, ...entry.args].join(" ")}`;
    return { path: null, backup: null, content: command, written: false };
  }
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  const content =
    client === "codex"
      ? updateCodexConfig(current, entry, remove)
      : updateJsonConfig(current, client, entry, remove);
  if (dryRun) return { path, backup: null, content, written: false };
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (current !== null) {
    backup = `${path}.bak-${options.now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, content);
  return { path, backup, content, written: true };
}
