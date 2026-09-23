/**
 * Huawei Cloud SDK-HMAC-SHA256 signature implementation
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hmacSha256Hex(key: Uint8Array, data: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key.slice().buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function buildCanonicalRequest(
  method: string,
  uri: string,
  query: string,
  headers: Map<string, string>,
  payloadHash: string,
): string {
  const signedHeaders: string[] = [];
  headers.forEach((_, k) => signedHeaders.push(k));
  signedHeaders.sort();
  const headerLines = signedHeaders.map((k) => `${k}:${headers.get(k) ?? ''}`);
  return [method, uri, query, headerLines.join('\n'), '', signedHeaders.join(';'), payloadHash].join('\n');
}

export async function signRequestHuawei(
  ak: string,
  sk: string,
  securityToken: string,
  method: string,
  urlStr: string,
  body: Uint8Array,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<Map<string, string>> {
  const url = new URL(urlStr);
  let uri = url.pathname;
  if (!uri.endsWith('/')) uri += '/';
  const query = url.search.slice(1);
  const dateStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const payloadHash = await sha256Hex(body);

  const headers = new Map<string, string>();
  headers.set('host', url.host);
  headers.set('x-sdk-date', dateStamp);
  headers.set('x-sdk-content-sha256', payloadHash);
  headers.set('x-security-token', securityToken);

  if (extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  }
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json');

  const signedHeaders: string[] = [];
  headers.forEach((_, k) => signedHeaders.push(k));
  signedHeaders.sort();

  const canonicalRequest = buildCanonicalRequest(method, uri, query, headers, payloadHash);
  const canonicalHash = await sha256Hex(new TextEncoder().encode(canonicalRequest));
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`;
  const signature = await hmacSha256Hex(new TextEncoder().encode(sk), new TextEncoder().encode(stringToSign));
  headers.set(
    'Authorization',
    `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`,
  );
  return headers;
}
