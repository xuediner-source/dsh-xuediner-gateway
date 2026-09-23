/**
 * Huawei Cloud CodeArts STS token helpers (DPoP-signed refresh).
 *
 * Credentials are persisted by login-codearts.mjs with:
 *   access_key_id / secret_access_key / security_token / expires_at
 *   refresh_token / code_verifier / dpop_private_key_jwk
 */
import { SignJWT, importJWK } from 'jose';
import { randomBytes } from 'node:crypto';

export const STS_TOKEN_ENDPOINT = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
export const CLIENT_ID = 'codearts-agent';

export interface DpopPrivateJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
}

export interface DpopKeyPair {
  privateKeyJwk: DpopPrivateJwk;
  publicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}

export function keyPairFromStoredJwk(jwk: DpopPrivateJwk): DpopKeyPair {
  return {
    privateKeyJwk: jwk,
    publicKeyJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  };
}

/** Sign a DPoP proof JWT (htm = HTTP method, htu = full URL). */
export async function signDpopJws(keyPair: DpopKeyPair, htm: string, htu: string): Promise<string> {
  const key = await importJWK(keyPair.privateKeyJwk as unknown as JsonWebKey, 'ES256', { extractable: false });
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(32).toString('hex'),
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: keyPair.publicKeyJwk as unknown as JsonWebKey })
    .sign(key);
}

export interface TokenResponse {
  credentials?: {
    access_key_id?: string;
    secret_access_key?: string;
    security_token?: string;
    expiration?: string;
  };
  refresh_token?: string;
  error?: string;
  error_code?: string;
  error_msg?: string;
}

/** One DPoP-signed STS token request. */
export async function requestToken(
  body: Record<string, string>,
  keyPair: DpopKeyPair,
  timeoutMs = 30_000,
): Promise<TokenResponse> {
  const dpop = await signDpopJws(keyPair, 'POST', STS_TOKEN_ENDPOINT);
  let response: Response;
  try {
    response = await fetch(STS_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        DPoP: dpop,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`CodeArts STS network error: ${String(error)}`);
  }
  let data: TokenResponse | null = null;
  try {
    data = (await response.json()) as TokenResponse;
  } catch {
    data = null;
  }
  if (!response.ok || !data?.credentials) {
    const message = `CodeArts STS ${response.status}: ${JSON.stringify(data)}`;
    const errorCode = String(data?.error_code ?? '');
    const err = new Error(message) as Error & { fatal?: boolean };
    if (
      data?.error === 'invalid_grant'
      || errorCode.includes('ExpiredRefreshToken')
      || errorCode.includes('InvalidDPoPHeader')
    ) {
      err.fatal = true;
    }
    throw err;
  }
  return data;
}

/** refresh_token grant (silent renewal; keeps the same code_verifier). */
export async function exchangeRefreshToken(
  refreshToken: string,
  codeVerifier: string,
  keyPair: DpopKeyPair,
): Promise<TokenResponse> {
  return requestToken(
    {
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    keyPair,
  );
}
