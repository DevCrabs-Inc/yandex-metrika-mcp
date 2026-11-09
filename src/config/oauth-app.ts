/**
 * The public DevCrabs OAuth application in Yandex ID (registered 2026-11-09,
 * scope metrika:read only). It is a public PKCE client: there is no client
 * secret anywhere in this package. YM_MCP_CLIENT_ID overrides it.
 */
export const DEFAULT_CLIENT_ID: string | null = "f5d4257d517540deb401326d8c350d2d";

/** Register each as http://127.0.0.1:<port>/callback in the OAuth application. */
export const DEFAULT_REDIRECT_PORTS: readonly number[] = [47613, 47614, 47615];
