# Release checklist

Status of the release gates G0–G3 defined in [requirements.md](requirements.md#release-gates). An item is done only with evidence: a test, a recorded run or a link.

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
- [x] CI installs the packed tarball, runs the stdio e2e tests against it and enforces a bundle size limit; actions and `mcp-publisher` are pinned and checksummed.
- [x] Russian user docs, English quickstart, SECURITY, CONTRIBUTING, CHANGELOG.

## Needs people or accounts (blocks the public "production" claim)

- [x] Register the DevCrabs OAuth app in Yandex ID (`metrika:read`, redirect URIs `http://127.0.0.1:47613…47615/callback`), put its client ID into `src/config/oauth-app.ts` (2026-11-09; credentials in 1Password "Dev Env").
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

- [x] npm organisation `dev-crabs`; the package is `@dev-crabs/yandex-metrika-mcp`.
- [x] Repository public, private vulnerability reporting enabled (2026-11-09).
- [x] `1.0.0-beta.1` published to npm by hand with 2FA (2026-11-09) for the live sign-in check: the account requires 2FA, which a token in CI cannot supply. npm also created a `0.0.0-stage` placeholder version for its staged publishing.
- [x] Trusted publishing for `release.yml` (npmjs.com → the package → Settings → Trusted publishing → GitHub Actions, `DevCrabs-Inc` / `yandex-metrika-mcp` / `release.yml`).
- [x] `v1.0.0` (2026-11-09): CI published npm `latest` with provenance and the GitHub release with notes and the MCPB. The MCP Registry entry `io.github.DevCrabs-Inc/yandex-metrika-mcp` 1.0.0 was published from main by the MCP Registry workflow after the description was shortened to the 100-character limit.
- [ ] Delete the `NPM_TOKEN` secret, revoke the token on npmjs.com and set the package to "Require two-factor authentication and disallow tokens".
- [ ] Every version bump updates `.cursor-plugin/plugin.json`, `plugins/claude/.claude-plugin/plugin.json` and the pinned version in `plugins/claude/.mcp.json`; `test/unit/packaging.test.ts` fails otherwise.

## Listings after the release

Checked on 2026-11-09. All need the public repository and the package on npm.

- [x] Official MCP Registry: published by `release.yml`. Check `https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.DevCrabs-Inc/yandex-metrika-mcp`.
- [ ] Glama: `glama.json` is in the repo; use "Add Server" on glama.ai/mcp/servers, then set the Dockerfile there to get a score badge.
- [ ] punkpeye/awesome-mcp-servers: PR to the Marketing section with the Glama badge.
- [ ] mcpservers.org, mcp.so, mcpmarket.com: free submission forms.
- [ ] GitHub MCP Registry: email partnerships@github.com once the server is in the official registry.
- [ ] cursor.directory: paste the repo URL; it reads `.mcp.json`.
- [ ] Cursor Marketplace: submit the repo at cursor.com/marketplace/publish (`.cursor-plugin/plugin.json`).
- [ ] Cline MCP Marketplace: issue with `assets/logo-400.png`; Cline installs from README and `llms-install.md`.
- [ ] Claude directory: submit the plugin in `plugins/claude` from a Pro or higher account at claude.ai/directory/manage (MCPB listings are no longer accepted; local servers run in Claude Code and Cowork, not in chat).
- Later: Docker MCP Catalog (needs a tested `YANDEX_METRIKA_TOKEN` path in a container); remote-only directories (Claude connectors, ChatGPT) need remote mode (G4). Skip Smithery (closed to new connections since 2026-10-31) and PulseMCP until it reopens.
