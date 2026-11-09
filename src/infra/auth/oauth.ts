import { createHash, randomBytes } from "node:crypto";
import { type FetchLike, httpRequest } from "../http.ts";

export const AUTHORIZE_URL = "https://oauth.yandex.ru/authorize";
export const TOKEN_URL = "https://oauth.yandex.ru/token";
export const READ_SCOPE = "metrika:read";

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export const randomToken = (bytes = 24): string => randomBytes(bytes).toString("base64url");

export interface AuthorizeParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
  /** Ask Yandex to show the consent screen again, e.g. to pick another account. */
  readonly forceConfirm: boolean;
}

export function authorizeUrl(params: AuthorizeParams): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: READ_SCOPE,
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
  });
  if (params.forceConfirm) query.set("force_confirm", "yes");
  return `${AUTHORIZE_URL}?${query.toString()}`;
}

export interface TokenSet {
  readonly access_token: string;
  readonly refresh_token: string | null;
  /** ISO time; null when the provider did not report a lifetime. */
  readonly expires_at: string | null;
}

export class OAuthError extends Error {
  override readonly name = "OAuthError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const OAUTH_MESSAGES: Record<string, string> = {
  invalid_grant:
    "The sign-in code is invalid, expired or was already used. Start the sign-in again.",
  invalid_client: "The OAuth application is not recognised by Yandex. Check the client ID.",
  unauthorized_client: "The OAuth application is not allowed to use this flow.",
  invalid_scope: "Yandex rejected the requested access scope (metrika:read).",
  access_denied: "Access was not granted in Yandex.",
};

export const oauthMessage = (code: string): string =>
  OAUTH_MESSAGES[code] ?? "Yandex sign-in failed. Start the sign-in again.";

async function tokenRequest(
  fetchImpl: FetchLike,
  body: URLSearchParams,
  now: Date,
): Promise<TokenSet> {
  const response = await httpRequest(fetchImpl, {
    method: "POST",
    url: TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    timeoutMs: 20_000,
    maxBytes: 64 * 1024,
  });
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(response.text) as Record<string, unknown>;
  } catch {
    throw new OAuthError("invalid_response", "Yandex returned an unreadable token response.");
  }
  if (response.status !== 200 || typeof json["access_token"] !== "string") {
    const code = typeof json["error"] === "string" ? json["error"] : `http_${response.status}`;
    throw new OAuthError(code, oauthMessage(code));
  }
  const expiresIn = typeof json["expires_in"] === "number" ? json["expires_in"] : null;
  return {
    access_token: json["access_token"],
    refresh_token: typeof json["refresh_token"] === "string" ? json["refresh_token"] : null,
    expires_at:
      expiresIn === null ? null : new Date(now.getTime() + expiresIn * 1000).toISOString(),
  };
}

/** PKCE code exchange: no client secret is sent or embedded in the package. */
export function exchangeCode(
  fetchImpl: FetchLike,
  params: { readonly clientId: string; readonly code: string; readonly verifier: string },
  now: Date,
): Promise<TokenSet> {
  return tokenRequest(
    fetchImpl,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      client_id: params.clientId,
      code_verifier: params.verifier,
    }),
    now,
  );
}

/**
 * Refresh without a client secret. Whether Yandex allows this for public
 * clients is not documented; a failure simply means "sign in again".
 */
export function refreshTokenSet(
  fetchImpl: FetchLike,
  params: { readonly clientId: string; readonly refreshToken: string },
  now: Date,
): Promise<TokenSet> {
  return tokenRequest(
    fetchImpl,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: params.clientId,
    }),
    now,
  );
}
