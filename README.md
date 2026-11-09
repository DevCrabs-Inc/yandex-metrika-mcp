<p align="center"><img src="assets/logo-512.png" width="160" alt="Yandex Metrika MCP logo: a crab holding a chart"></p>

# Yandex Metrika MCP

Read-only MCP server for **Yandex Metrika** (Yandex Metrica, Яндекс Метрика). Connect it to Claude, Cursor, VS Code, Codex or any MCP client and ask about traffic, sources, landing pages and goals. Every answer comes with exact dates, the counter time zone, sampling status, filters and provenance, so the numbers can be checked.

**Документация на русском: [README.ru.md](README.ru.md) и [docs/ru](docs/ru/README.md).**

> Status: **1.0.0**, the first stable release; tool names, arguments and outputs follow semantic versioning. Covered by tests against synthetic data and a simulated API, and checked with a live Yandex sign-in and reports on macOS. Other clients and platforms are tracked in [docs/release-checklist.md](docs/release-checklist.md).

## Why this server

- **Sign in through the browser.** No token pasting, no OAuth app of your own; the token never enters the chat.
- **Numbers you can verify.** Calendar periods in the counter time zone, complete days by default, strict accuracy that refuses sampled data instead of calling it exact, API totals instead of sums of visible rows.
- **Several accounts and clients.** Isolated connections with their own counters; nothing is shared between them.
- **Full exports.** Background CSV/JSON export of every row with checksums, a manifest and resume after a restart.
- **Small, predictable surface.** 13 tools, 3 prompts. Read-only: no write endpoints, no raw HTTP tool.

## Install

Requires Node.js 22.13 or later. No API key and no OAuth app of your own: after installing, ask the assistant to connect Yandex Metrika and sign in through the browser.

**One command** (writes the client config and keeps a backup):

```bash
npx -y @dev-crabs/yandex-metrika-mcp setup --client claude-desktop   # or claude-code, cursor, vscode, windsurf, codex
```

**One click:**

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](<https://cursor.com/install-mcp?name=yandex-metrika&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBkZXYtY3JhYnMveWFuZGV4LW1ldHJpa2EtbWNwIl19>) [Install in VS Code](<https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522yandex-metrika%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522%2540dev-crabs%252Fyandex-metrika-mcp%2522%255D%257D>)

**Claude Code:**

```bash
claude mcp add --scope user yandex-metrika -- npx -y @dev-crabs/yandex-metrika-mcp
```

**Any MCP client** (`mcpServers` format; VS Code uses `servers` with `"type": "stdio"`):

```json
{
  "mcpServers": {
    "yandex-metrika": { "command": "npx", "args": ["-y", "@dev-crabs/yandex-metrika-mcp"] }
  }
}
```

On Windows some clients cannot start `npx` directly; use `"command": "cmd", "args": ["/c", "npx", "-y", "@dev-crabs/yandex-metrika-mcp"]`, which is what `setup` writes there. Claude Desktop users can also install the `.mcpb` bundle from the GitHub release. AI agents installing the server should follow [llms-install.md](llms-install.md).

Restart the client and ask: _"Connect Yandex Metrika and compare the last two weeks by traffic source."_ The assistant calls `metrika_connect` and gives you a local sign-in link. Try it without an account: the synthetic `conn_demo` connection is always available.

## Example questions

- "Compare the last two complete weeks by visits and target visits of goal 3001."
- "Which landing pages brought the most leads for goal X last month?"
- "Show weekly visits since the start of the quarter."
- "Export all traffic sources for October to CSV for Excel."

## Tools

| Tool                                                                                         | Purpose                                                                |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `metrika_status`                                                                             | Connections, exports and the next step. Works before sign-in.          |
| `metrika_connect` / `metrika_disconnect`                                                     | Browser sign-in; local removal of a connection and its token.          |
| `metrika_list_counters` / `metrika_describe_counter`                                         | Sites, time zones and goals with IDs.                                  |
| `metrika_catalog`                                                                            | Presets, metrics (with aggregation rules), dimensions, period presets. |
| `metrika_run_report`                                                                         | One period: presets or explicit fields, filters, sorting, paging.      |
| `metrika_compare_periods`                                                                    | Two periods under identical conditions: absolute, % and p.p. changes.  |
| `metrika_run_timeseries`                                                                     | Day, week or month buckets with exact calendar boundaries.             |
| `metrika_export_report` / `metrika_get_job` / `metrika_cancel_job` / `metrika_read_artifact` | Full CSV/JSON exports as resumable background jobs.                    |

Prompts: `weekly_review`, `traffic_drop`, `landing_conversion`.

## Data and privacy

Report data you request is sent to your AI client and its model provider; tokens never are. Tokens live in the OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service). Without one, the server refuses to store tokens unless you explicitly choose an unencrypted user-only file. URL query strings are removed from labels by default. No telemetry. Details: [docs/ru/privacy-security.md](docs/ru/privacy-security.md).

## Development

```bash
pnpm install
pnpm check        # Biome, tsc, vitest
pnpm build        # dist/cli.js
pnpm mcpb         # build/yandex-metrika-mcp-<version>.mcpb
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Security reports: [SECURITY.md](SECURITY.md).

## License

MIT © DevCrabs
