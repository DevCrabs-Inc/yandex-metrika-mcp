import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_DIR_NAME = "yandex-metrika-mcp";

/** Per-user data directory: SQLite state, managed exports and the optional secrets file. */
export function defaultDataDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env["YM_MCP_DATA_DIR"];
  if (override) return override;
  if (platform === "darwin") return join(home, "Library", "Application Support", APP_DIR_NAME);
  if (platform === "win32")
    return join(env["LOCALAPPDATA"] || join(home, "AppData", "Local"), APP_DIR_NAME);
  return join(env["XDG_DATA_HOME"] || join(home, ".local", "share"), APP_DIR_NAME);
}

export interface DataPaths {
  readonly root: string;
  readonly database: string;
  readonly secretsFile: string;
  readonly jobs: string;
  readonly artifacts: string;
}

export function dataPaths(root: string): DataPaths {
  return {
    root,
    database: join(root, "state.sqlite"),
    secretsFile: join(root, "secrets.json"),
    jobs: join(root, "jobs"),
    artifacts: join(root, "artifacts"),
  };
}

export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [paths.root, paths.jobs, paths.artifacts]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
