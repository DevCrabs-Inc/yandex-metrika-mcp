# Yandex Metrika MCP

Read-only MCP server for **Yandex Metrika** (Yandex Metrica, Яндекс Метрика) web analytics. Connect it to an AI client and get reports you can check: every number comes with its dates, time zone, filters, sampling status and provenance.

> **Status: pre-alpha.** Only the synthetic demo connection works today. Yandex sign-in, exports and packaged releases (npm, MCPB) are not available yet. Nothing is published to npm.

## What it does

| Tool                       | Purpose                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `metrika_status`           | Server version, connections and the next step. Works without sign-in.                   |
| `metrika_catalog`          | Presets, metrics (with unit and aggregation rules), dimensions and period presets.      |
| `metrika_list_counters`    | Counters (sites) available through a connection.                                        |
| `metrika_describe_counter` | Counter time zone and goals with IDs.                                                   |
| `metrika_run_report`       | One-period report: presets or explicit metrics/dimensions, filters, sorting, paging.    |
| `metrika_compare_periods`  | Two periods under identical conditions: absolute, percent and percentage-point changes. |
| `metrika_run_timeseries`   | Day, week or month buckets with exact calendar boundaries.                              |

Prompts: `weekly_review`, `traffic_drop`, `landing_conversion`.

## Data correctness rules

- Periods are calendar dates in the **counter time zone**. Defaults use complete days: the last 7 complete days for reports and the last two complete ISO weeks (Mon–Sun) for comparisons.
- `accuracy: "strict"` (the default) refuses sampled or unverifiable data instead of presenting it as exact. `"balanced"` accepts sampling and always says so.
- Unknown stays unknown. A missing `sampled` flag is not "not sampled", a segment missing from a top-N list is not zero, and a zero baseline has no percent change.
- Totals come from the API. Users are never summed across rows, and rates are never averaged.
- Goal reaches are completions, not leads.
- No implicit robot filters or attribution changes. Every condition is visible in the result's `query`.
- Responses stay under 48 KiB. When rows are cut, the result says why and returns a signed cursor for the next page.

## Try it from source

Requires Node.js 22.13 or later and pnpm.

```bash
pnpm install
pnpm build
node dist/cli.js demo     # sample week-over-week comparison on synthetic data
node dist/cli.js doctor   # environment report, no secrets
```

Add it to Claude Code:

```bash
claude mcp add yandex-metrika -- node /absolute/path/to/yandex-metrika-mcp/dist/cli.js
```

Or to any client that takes a JSON config (Claude Desktop, Cursor and others):

```json
{
  "mcpServers": {
    "yandex-metrika": {
      "command": "node",
      "args": ["/absolute/path/to/yandex-metrika-mcp/dist/cli.js"]
    }
  }
}
```

Then ask: "Use the demo connection and compare the last two weeks by traffic source."

## Development

```bash
make setup    # install dependencies and git hooks
pnpm dev      # run the server from source over stdio
pnpm check    # lint, typecheck and tests
make inspect  # open the MCP Inspector against the built server
```

See [AGENTS.md](AGENTS.md) for architecture and coding rules.

## License

MIT
