// Cloudflare Access 驗證
//
// 正式環境：在 Cloudflare Zero Trust 為本站建立 Access Application，
// 並在 Pages 環境變數設定：
//   CF_ACCESS_TEAM_DOMAIN = <team>.cloudflareaccess.com
//   CF_ACCESS_AUD         = Access Application 的 Audience (AUD) Tag
// 設定後每個 API 請求都會驗證 Cf-Access-Jwt-Assertion（RS256），
// 並以 JWT 內的 email 作為操作者（寫入 created_by）。
//
// 本機開發：未設定 CF_ACCESS_AUD 時視為開發模式，操作者 = 'dev@local'。

import { HttpError } from './http.js';

let jwksCache = { url: null, keys: null, at: 0 };

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getKeys(teamDomain) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (jwksCache.url === url && jwksCache.keys && Date.now() - jwksCache.at < 3600_000) {
    return jwksCache.keys;
  }
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(503, '無法取得 Cloudflare Access 公鑰');
  const { keys } = await res.json();
  jwksCache = { url, keys, at: Date.now() };
  return keys;
}

async function verifyAccessJwt(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, '登入憑證格式錯誤');
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));

  const keys = await getKeys(env.CF_ACCESS_TEAM_DOMAIN);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, '登入憑證金鑰不符');

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new HttpError(401, '登入憑證驗證失敗');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new HttpError(401, '登入已過期，請重新整理頁面');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.CF_ACCESS_AUD)) throw new HttpError(401, '登入憑證不屬於本系統');
  if (payload.iss && payload.iss !== `https://${env.CF_ACCESS_TEAM_DOMAIN}`) {
    throw new HttpError(401, '登入憑證發行者不符');
  }
  return payload.email || payload.sub || 'unknown';
}

/** 回傳操作者 email；驗證失敗拋出 401 */
export async function authenticate(request, env) {
  if (!env.CF_ACCESS_AUD || !env.CF_ACCESS_TEAM_DOMAIN) {
    return 'dev@local';
  }
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    (request.headers.get('Cookie') || '').match(/CF_Authorization=([^;]+)/)?.[1];
  if (!token) throw new HttpError(401, '未登入（缺少 Cloudflare Access 憑證）');
  return verifyAccessJwt(token, env);
}
