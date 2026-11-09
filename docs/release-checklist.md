# Release checklist

Status of the release gates from the product spec (G0–G3). An item is done only with evidence: a test, a recorded run or a link.

## Done in code

- [x] 13 P0 tools, 3 prompts, artifact resource; read-only route allowlist.
- [x] Browser sign-in (PKCE, loopback, one-time state, CSRF), token import, environment token.
- [x] OS credential store with explicit file opt-in; no secrets in logs or tool I/O.
- [x] Isolated connections with generations, allowlists, disconnect cleanup.
- [x] Data-correctness rules D-01…D-09 (T01–T15) covered by unit and integration tests.
- [x] Quotas, retries, Retry-After, cache with `refresh` / `allow_stale` (T19, T23–T25).
- [x] Durable exports with checkpoints, drift handling, resume, cancel, atomic publish, manifest (T11, T12, T22, T26–T31).
- [x] Setup wizard for six clients, `doctor`, `jobs`, `demo`.
- [x] npm package metadata, MCPB build, Dockerfile, MCP Registry `server.json`, release workflow.
- [x] Russian user docs, English quickstart, SECURITY, CONTRIBUTING, CHANGELOG.

## Needs people or accounts (blocks the public "production" claim)

- [ ] Register the DevCrabs OAuth app in Yandex ID (`metrika:read`, redirect URIs `http://127.0.0.1:47613…47615/callback`), put its client ID into `src/config/oauth-app.ts`.
- [ ] G0 live check of the flow: new account, consent, deny, expired code, replay, token lifetime, refresh without secret.
- [ ] Re-verify the items in [api-notes.md](api-notes.md) marked as not verified (week buckets, management fields, error body).
- [ ] Live reconciliation with the Metrika UI for overview, sources, landing pages, devices, a goal, a time series, a comparison and a multi-page export.
- [ ] Client matrix (record version, OS, transport, result):

| Client                | macOS    | Windows  | Linux    |
| --------------------- | -------- | -------- | -------- |
| Claude Desktop (MCPB) | untested | untested | n/a      |
| Claude Desktop (npx)  | untested | untested | n/a      |
| Claude Code           | untested | untested | untested |
| Cursor                | untested | untested | untested |
| VS Code               | untested | untested | untested |
| Codex                 | untested | untested | untested |

- [ ] Clean install from the npm tarball and the MCPB on each OS (T33).
- [ ] Pilot with 10 users: first real report within 10 minutes for 8 of 10.

## Publishing

- [ ] Create the npm organisation `devcrabs`, add `NPM_TOKEN` to repository secrets (or configure trusted publishing).
- [ ] Make the GitHub repository public; enable private vulnerability reporting.
- [ ] Tag `v1.0.0-beta.1`; the release workflow publishes npm, the MCPB and the MCP Registry entry.
- [ ] Submissions to directories (Claude extensions, Smithery, Glama, PulseMCP, mcp.so, awesome lists) happen with the marketing work.
