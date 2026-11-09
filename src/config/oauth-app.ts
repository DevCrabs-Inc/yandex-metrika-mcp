/**
 * The public DevCrabs OAuth application (Yandex ID, scope metrika:read). It is
 * a public PKCE client: there is no client secret anywhere in this package.
 * Until the application is registered, browser sign-in needs YM_MCP_CLIENT_ID.
 */
export const DEFAULT_CLIENT_ID: string | null = null;

/** Register each as http://127.0.0.1:<port>/callback in the OAuth application. */
export const DEFAULT_REDIRECT_PORTS: readonly number[] = [47613, 47614, 47615];
