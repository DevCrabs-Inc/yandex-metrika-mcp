# Yandex API notes

What the implementation relies on, and how well each point is verified. Re-check before every release; the official docs change.

## Verified against official documentation

| Fact                                                                                                                                                                                                                                           | Source                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `Authorization: OAuth <token>` header, host `api-metrika.yandex.net`                                                                                                                                                                           | Metrika authorization docs        |
| Scopes `metrika:read` / `metrika:write`                                                                                                                                                                                                        | Metrika authorization docs        |
| Authorize params: `response_type`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method` (`S256`), `force_confirm`                                                                                          | Yandex ID code-url                |
| PKCE exchange works without `client_secret` when `code_verifier` is sent                                                                                                                                                                       | Yandex ID code-url, token section |
| A non-exact `redirect_uri` is ignored (falls back to the first registered URI)                                                                                                                                                                 | Yandex ID code-url                |
| Token response: `access_token`, `expires_in`, `refresh_token`, `token_type`                                                                                                                                                                    | Yandex ID code-url                |
| Token revocation needs the client secret, so a public client cannot revoke                                                                                                                                                                     | Yandex ID token-invalidate        |
| Quotas: 30 req/s per IP, 3 parallel and 5000/day per user, 200 `/stat/v1/data` per 5 min, reset 00:00 UTC, HTTP 429                                                                                                                            | Metrika quotas                    |
| `/stat/v1/data`: max 20 metrics, 10 dimensions, `limit` up to 100000, 1-based `offset`; response `total_rows`, `total_rows_rounded`, `sampled`, `sample_share`, `sample_size`, `sample_space`, `data_lag`, `contains_sensitive_data`, `totals` | Reports API `data`                |
| bytime: `group` values, `top_keys` default 7 / max 30, nested `metrics`/`totals` arrays, **no time axis in the response**                                                                                                                      | Reports API `bytime`              |
| Filter operators `==`, `!=`, `=@`, `!@`, `=~`, `!~`, `=*`, `!*`, `=.`, `!.`; `AND`/`OR`/`NOT`; `'` and `\` escaped with `\`; ≤20 conditions                                                                                                    | Segmentation docs                 |
| Goals response root `goals[]` with `id`, `name`, `type`                                                                                                                                                                                        | Management goals                  |

## Implemented from working code, not yet re-verified in docs

| Assumption                                                                                                                 | Basis                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `GET /management/v1/counter/{id}` returns `{ counter: { id, site, time_zone_name, status } }`                              | DevCrabs weekly collector in production                |
| `accuracy=full` asks for unsampled data                                                                                    | DevCrabs weekly collector (checks `sampled === false`) |
| `GET /management/v1/counters?per_page=1000` returns `{ rows, counters[] }` with `name`, `site`, `site2.site`, `permission` | Common usage; fields are parsed loosely                |
| Error body shape `{ errors: [{ error_type, message }], message }`                                                          | Parsed defensively; only `message` text is used        |

## Not verified, handled conservatively

- Whether bytime week buckets follow ISO weeks or 7-day chunks from `date1`: weekly series must start on a Monday, where both agree.
- Whether `=.()` list syntax is valid: lists are compiled to `OR`/`AND` of single conditions.
- Whether a public client can refresh without a secret: refresh is attempted once; failure means signing in again. The Yandex ID refresh page (`tokens/refresh-client`, read 2026-11-09) lists only `grant_type` and `refresh_token` as required and `client_id` / `client_secret` as additional parameters; it says nothing about apps without a secret.
- Loopback redirects at sign-in time. The docs (`register-auth`, `codes/code-url`, read 2026-11-09) only say that several Redirect URIs can be registered and that matching is exact on scheme, host, port and path. The registration form of a "for user authorization" app accepted `http://127.0.0.1:47613/callback`, `:47614/callback` and `:47615/callback` (2026-11-09); a live sign-in still has to confirm the redirect.
- Metrika permissions offered in the registration form (2026-11-09): `metrika:read`, `metrika:write`, `metrika:offline_data`, `metrika:expenses`, `metrika:user_params`, `metrika:segments`. The DevCrabs app requests only `metrika:read`.
- Moderation: the `unauthorized_client` error means the app was rejected by moderation or is still waiting for it (`codes/code-url`). How long moderation takes and whether it applies to this app type is not stated.
