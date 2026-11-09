# Security policy

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub private vulnerability reporting: _Security → Report a vulnerability_ in this repository. Include the version (`yandex-metrika-mcp --version`), the platform and steps to reproduce. Never include real OAuth tokens, authorization codes or client report data.

We aim to acknowledge reports within 5 working days and to agree on a disclosure date with the reporter.

## Supported versions

Only the latest release line receives security fixes.

## Scope

In scope: token handling and storage, the local sign-in page and OAuth flow, tenant/connection isolation, path handling of exports, prompt-injection paths through tool output, and anything that lets the server write to Yandex Metrika.

Out of scope: vulnerabilities in MCP clients, in Yandex services, or caused by running with `YM_MCP_PRIVACY=full` or `YM_MCP_SECRET_STORE=file` as documented.

By design, not a vulnerability on its own: a model that follows instructions found in report labels, page titles or UTM tags. The model is not a trust boundary, so the server never relies on it: labels are sanitized and marked as external data, no tool can write to Yandex Metrika, and no tool argument can reach another host, file path or connection. A report that shows how such text gets past these controls (for example, makes the server act on another connection or leak a token) is in scope.

## Security model in brief

- Read-only routes only; no generic HTTP tool, no tool argument controls hosts, headers or file paths.
- Public OAuth client with PKCE (S256); no client secret is shipped.
- Tokens are kept in the OS credential store; an unencrypted file store is opt-in only.
- The local sign-in server binds to 127.0.0.1, checks Host/Origin, uses one-time state, CSRF tokens and a strict CSP.
- Jobs, artifacts, caches and cursors are bound to a connection and its generation.
- Labels from the API (URLs, UTM tags, titles, counter and goal names) lose control and invisible characters and are wrapped in a per-response `<untrusted-data-…>` block in text output.
- Error hints (`details.candidates`) come only from the catalog and from resources of the same connection.

The full description (in Russian) is in [docs/ru/privacy-security.md](docs/ru/privacy-security.md).
