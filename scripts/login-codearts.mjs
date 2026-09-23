// login-codearts.mjs
// Huawei Cloud CodeArts IAM OAuth 登录脚本 (PKCE + DPoP)
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, importJWK, SignJWT } from 'jose';
import fs from 'node:fs';
import path from 'node:path';

const CLIENT_ID = 'codearts-agent';
const REDIRECT_PATH = '/oauth/callback';
const STS_TOKEN_ENDPOINT = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
const PORTAL_AUTHORIZE_BASE = 'https://codearts.huaweicloud.com/portal/authorize';
const PORTAL_LOGIN_BASE = 'https://codearts.huaweicloud.com/portal/login';
const LOGIN_PLUGIN_NAME = 'snap_AIIDE';
const LOGIN_PLUGIN_VERSION = '5.2.0';
const OAUTH_THEME = '2';
const OAUTH_LOCALE = 'zh-cn';
const MIN_CALLBACK_PORT = 10000;

function generatePkcePair() {
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

async function generateDpopKeyPair() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true, crv: 'P-256' });
  return {
    privateKeyJwk: await exportJWK(privateKey),
    publicKeyJwk: await exportJWK(publicKey),
  };
}

async function signDpopJws(keyPair, htm, htu) {
  const key = await importJWK(keyPair.privateKeyJwk, 'ES256', { extractable: false });
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(32).toString('hex'),
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: keyPair.publicKeyJwk })
    .sign(key);
}

function buildOAuthLoginUrl(port, pkce, ticketId) {
  return (
    `${PORTAL_AUTHORIZE_BASE}?theme=${OAUTH_THEME}&locale=${OAUTH_LOCALE}` +
    `&uri_scheme=${CLIENT_ID}&client_id=${CLIENT_ID}&port=${port}` +
    `&code_challenge=${pkce.codeChallenge}&code_challenge_method=SHA-256` +
    `&ticket_id=${ticketId}&plugin-name=${LOGIN_PLUGIN_NAME}&plugin-version=${LOGIN_PLUGIN_VERSION}`
  );
}

function buildPortalLoginResultUrl(succeeded) {
  return `${PORTAL_LOGIN_BASE}?login_succeed=${succeeded}&uri_scheme=${CLIENT_ID}&locale=${OAUTH_LOCALE}`;
}

async function exchangeAuthorizationCode(code, codeVerifier, port, keyPair) {
  const dpop = await signDpopJws(keyPair, 'POST', STS_TOKEN_ENDPOINT);
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: `http://127.0.0.1:${port}${REDIRECT_PATH}`,
  }).toString();

  const response = await fetch(STS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      DPoP: dpop,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await response.json();
  if (!response.ok || !data.credentials) {
    throw new Error(`STS token exchange failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function listenOnCallbackPort(server) {
  return new Promise((resolve, reject) => {
    const tryListen = (port) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        const assigned = typeof addr === 'object' && addr ? addr.port : 0;
        if (assigned >= MIN_CALLBACK_PORT) {
          resolve(assigned);
          return;
        }
        server.close(() => {
          const retry = Math.floor(Math.random() * (65536 - MIN_CALLBACK_PORT)) + MIN_CALLBACK_PORT;
          tryListen(retry);
        });
      });
    };
    tryListen(0);
  });
}

async function main() {
  const ticketId = randomBytes(32).toString('hex');
  const pkce = generatePkcePair();
  const keyPair = await generateDpopKeyPair();

  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${req.socket.localPort}`);
    if (url.pathname !== REDIRECT_PATH) {
      res.writeHead(404).end('Not found');
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS).end();
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400).end('Missing code');
      return;
    }

    const port = req.socket.localPort;
    exchangeAuthorizationCode(code, pkce.codeVerifier, port, keyPair)
      .then((tokenData) => {
        res.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(true) }).end();
        const cred = {
          access_key_id: tokenData.credentials.access_key_id,
          secret_access_key: tokenData.credentials.secret_access_key,
          security_token: tokenData.credentials.security_token,
          expires_at: tokenData.credentials.expiration,
          refresh_token: tokenData.refresh_token,
          code_verifier: pkce.codeVerifier,
          dpop_private_key_jwk: keyPair.privateKeyJwk,
        };
        resolveResult(cred);
      })
      .catch((err) => {
        res.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(false) }).end();
        rejectResult(err);
      });
  });

  const port = await listenOnCallbackPort(server);
  const loginUrl = buildOAuthLoginUrl(port, pkce, ticketId);

  console.log(`CODEARTS_PORT:${port}`);
  console.log(`CODEARTS_LOGIN_URL:${loginUrl}`);
  console.log('READY_FOR_LOGIN');

  try {
    const cred = await resultPromise;
    console.log('\nLOGIN_SUCCESS');

    // 1. Save to <gateway>/auths/codearts-<ak>.json (override with
    //    XUEDINER_GATEWAY_DIR; falls back to the bundled ./gateway checkout).
    const gwDir = process.env.XUEDINER_GATEWAY_DIR || process.env.WORKBUDDY_GATEWAY_DIR;
    const authsDir = gwDir ? path.join(gwDir, 'auths') : path.resolve('gateway', 'auths');
    if (!fs.existsSync(authsDir)) fs.mkdirSync(authsDir, { recursive: true });
    const akShort = cred.access_key_id.slice(0, 8);
    const codeartsNamedFile = path.join(authsDir, `codearts-${akShort}.json`);
    const codeartsFile = path.join(authsDir, 'codearts.json');
    fs.writeFileSync(codeartsNamedFile, JSON.stringify(cred, null, 2), 'utf8');
    fs.writeFileSync(codeartsFile, JSON.stringify(cred, null, 2), 'utf8');
    console.log(`CREDENTIAL_SAVED:${codeartsNamedFile}`);

    // 2. 写入 ~/.dsh/.credentials.yaml
    const credYamlPath = path.join(process.env.USERPROFILE, '.dsh', '.credentials.yaml');
    if (fs.existsSync(credYamlPath)) {
      let yaml = fs.readFileSync(credYamlPath, 'utf8');
      const credJson = JSON.stringify(cred);
      const escaped = credJson.replace(/'/g, "''");
      if (yaml.includes('CODEARTS_ACCESS_TOKEN:')) {
        yaml = yaml.replace(/CODEARTS_ACCESS_TOKEN:.*$/m, `CODEARTS_ACCESS_TOKEN: '${escaped}'`);
      } else {
        yaml = yaml.replace(/^refs:\r?\n/m, `refs:\r\n  CODEARTS_ACCESS_TOKEN: '${escaped}'\r\n`);
      }
      fs.writeFileSync(credYamlPath, yaml, 'utf8');
      console.log('DSH_CREDENTIAL_UPDATED:CODEARTS_ACCESS_TOKEN');
    }
  } catch (err) {
    console.error('LOGIN_ERROR:', err.message);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
