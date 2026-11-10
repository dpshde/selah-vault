// Orthodox Authentication (WebAuthn Passkeys ES256, Sign in with Apple RS256, Email OTP)
// and OAuth 2.1 Authorization Code + PKCE (S256) for Selah Vault v2.

import { fetchStaticAsset } from "./assets";
import { EMAIL_OTP_TTL_MS, signInCodeEmail } from "./email";
import {
  OAUTH_CODE_TTL_MS,
  OAUTH_GRANT_TTL_SEC,
  SCOPES,
  SESSION_TTL_SEC,
  b64uDecode,
  b64uEncode,
  clearSessionCookieHeader,
  extractTokenFromRequest,
  makeToken,
  newSecret,
  newUserId,
  parseScopes,
  parseToken,
  sessionCookieHeader,
  sha256B64u,
  sha256Bytes,
  sha256Hex,
  cookieWriteOriginError,
  validateOAuthClient,
} from "./clients";
import { CORS_HEADERS } from "./library";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  code: string;
}

export interface AuthEnv {
  DB: D1Database;
  LIBRARY: DurableObjectNamespace;
  ASSETS?: Fetcher;
  YVP_PUBLIC_APP_KEY?: string;
  APPLE_CLIENT_ID?: string;
  RESEND_API_KEY?: string;
  sendEmail?: (msg: EmailMessage) => Promise<void>;
  fetchJwks?: typeof fetch;
  now?: () => number;
}

/** Email OTP send: max codes per email address per sliding window. */
export const EMAIL_SEND_PER_EMAIL_MAX = 5;
/** Email OTP send: max codes per client IP per sliding window. */
export const EMAIL_SEND_PER_IP_MAX = 20;
/** Sliding window for OTP send rate limits. */
export const EMAIL_SEND_WINDOW_MS = 60 * 60_000;
/** Max failed+total verify attempts on a single OTP challenge (preserved across resends). */
export const EMAIL_VERIFY_MAX_ATTEMPTS = 5;
/** Cap total verify posts per email per sliding window (across codes/resends). */
export const EMAIL_VERIFY_PER_EMAIL_MAX = 15;
/** Sliding window for OTP verify rate limits. */
export const EMAIL_VERIFY_WINDOW_MS = 60 * 60_000;

export async function bumpRateLimit(
  db: D1Database,
  bucket: string,
  max: number,
  windowMs: number,
  nowMs: number,
): Promise<{ ok: boolean; count: number }> {
  const row = await db
    .prepare("SELECT count, window_start FROM rate_limits WHERE bucket = ?")
    .bind(bucket)
    .first<{ count: number; window_start: number }>();
  if (!row || nowMs - row.window_start >= windowMs) {
    await db
      .prepare("INSERT OR REPLACE INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)")
      .bind(bucket, nowMs)
      .run();
    return { ok: true, count: 1 };
  }
  if (row.count >= max) return { ok: false, count: row.count };
  await db.prepare("UPDATE rate_limits SET count = count + 1 WHERE bucket = ?").bind(bucket).run();
  return { ok: true, count: row.count + 1 };
}

export function clientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 128);
  const xff = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff.slice(0, 128);
  return "unknown";
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

// Minimal CBOR decoder for WebAuthn attestationObject & COSE_Key (RFC 8949 subset).
export function decodeCbor(bytes: Uint8Array, offset = 0): { value: unknown; next: number } {
  if (offset >= bytes.length) throw new Error("CBOR truncated");
  const initial = bytes[offset++];
  const major = initial >> 5;
  const info = initial & 0x1f;

  let len = 0;
  if (info < 24) len = info;
  else if (info === 24) len = bytes[offset++];
  else if (info === 25) {
    len = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
  } else if (info === 26) {
    len = ((bytes[offset] << 24) >>> 0) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
    offset += 4;
  } else {
    throw new Error("Unsupported CBOR length");
  }

  if (major === 0) return { value: len, next: offset };
  if (major === 1) return { value: -1 - len, next: offset };
  if (major === 2) return { value: bytes.slice(offset, offset + len), next: offset + len };
  if (major === 3) return { value: new TextDecoder().decode(bytes.slice(offset, offset + len)), next: offset + len };
  if (major === 4) {
    const arr: unknown[] = [];
    for (let i = 0; i < len; i++) {
      const item = decodeCbor(bytes, offset);
      arr.push(item.value);
      offset = item.next;
    }
    return { value: arr, next: offset };
  }
  if (major === 5) {
    const map = new Map<unknown, unknown>();
    for (let i = 0; i < len; i++) {
      const k = decodeCbor(bytes, offset);
      const v = decodeCbor(bytes, k.next);
      map.set(k.value, v.value);
      offset = v.next;
    }
    return { value: map, next: offset };
  }
  if (major === 7) {
    if (info === 20) return { value: false, next: offset };
    if (info === 21) return { value: true, next: offset };
    if (info === 22) return { value: null, next: offset };
  }
  throw new Error("Unsupported CBOR major type");
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function derToP1363(sig: Uint8Array): Uint8Array {
  if (sig.length === 64 && sig[0] !== 0x30) return sig;
  if (sig[0] !== 0x30) throw new Error("Invalid ECDSA DER signature");
  let pos = 2;
  if (sig[1] & 0x80) pos = 2 + (sig[1] & 0x7f);
  const readInt = (): Uint8Array => {
    if (sig[pos++] !== 0x02) throw new Error("Expected INTEGER tag");
    const len = sig[pos++];
    let slice = sig.slice(pos, pos + len);
    pos += len;
    while (slice.length > 32 && slice[0] === 0x00) slice = slice.slice(1);
    if (slice.length > 32) throw new Error("ECDSA coordinate too long");
    const out = new Uint8Array(32);
    out.set(slice, 32 - slice.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(s, 32);
  return out;
}

async function parseAttestation(attestationB64u: string, rpId: string) {
  const attBytes = b64uDecode(attestationB64u);
  const { value } = decodeCbor(attBytes);
  if (!(value instanceof Map)) throw new Error("Invalid attestationObject");
  const authData = value.get("authData");
  if (!(authData instanceof Uint8Array) || authData.length < 55) throw new Error("Invalid authData");

  const rpIdHash = authData.slice(0, 32);
  const expectedRpHash = await sha256Bytes(rpId);
  if (!equalBytes(rpIdHash, expectedRpHash)) throw new Error("RP ID hash mismatch");

  const flags = authData[32];
  if ((flags & 0x01) === 0 || (flags & 0x40) === 0) throw new Error("Missing UP or AT flag");
  const signCount = ((authData[33] << 24) >>> 0) + ((authData[34] << 16) | (authData[35] << 8) | authData[36]);
  const credIdLen = (authData[53] << 8) | authData[54];
  const credIdEnd = 55 + credIdLen;
  if (authData.length <= credIdEnd) throw new Error("Truncated attestedCredentialData");
  const credentialId = b64uEncode(authData.slice(55, credIdEnd));

  const cose = decodeCbor(authData, credIdEnd).value;
  if (!(cose instanceof Map)) throw new Error("Invalid COSE_Key");
  if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) {
    throw new Error("Expected ES256 P-256 COSE_Key");
  }
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (!(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32) {
    throw new Error("Invalid P-256 coordinates");
  }
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: b64uEncode(x), y: b64uEncode(y), ext: true };
  await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  return { credentialId, signCount, jwk };
}

async function callLibraryInternal(env: AuthEnv, userId: string, path: string, body: Record<string, unknown>): Promise<Response> {
  const stub = env.LIBRARY.get(env.LIBRARY.idFromName(userId));
  return stub.fetch(
    new Request(`https://library.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, ...body }),
    }),
  );
}

async function issueSessionResponse(
  env: AuthEnv,
  request: Request,
  user: { id: string; email: string | null; name: string },
): Promise<Response> {
  const token = makeToken(user.id);
  const secretHash = await sha256Hex(token.secret);
  const regRes = await callLibraryInternal(env, user.id, "/_internal/tokens", {
    name: user.name,
    secretHash,
    scopes: ["*"],
    clientId: null,
    ttlSec: SESSION_TTL_SEC,
  });
  const reg = (await regRes.json()) as { library?: { id: string; name: string } };
  const libName = reg.library?.name ?? user.name;
  return json(
    { token: token.raw, user: { id: user.id, email: user.email, name: libName } },
    200,
    { "set-cookie": sessionCookieHeader(token.raw, request.url) },
  );
}

export async function verifyBearerOrCookie(env: AuthEnv, request: Request) {
  const parsed = extractTokenFromRequest(request, false);
  if (!parsed) return null;
  const secretHash = await sha256Hex(parsed.secret);
  const res = await callLibraryInternal(env, parsed.userId, "/_internal/verify", { secretHash });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    tokenId: string;
    scopes: string[];
    clientId: string | null;
    library: { id: string; name: string };
  };
  return { parsed, secretHash, ...data };
}

async function handlePasskeyRegisterOptions(request: Request, env: AuthEnv, nowMs: number): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const t = await request.text();
    if (t) body = JSON.parse(t);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const existing = await verifyBearerOrCookie(env, request);
  const userId = existing ? existing.parsed.userId : newUserId();
  const displayName =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 80)
      : (existing?.library.name ?? "Personal");

  const challenge = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challengeId = `ch_${b64uEncode(crypto.getRandomValues(new Uint8Array(12)))}`;
  const secretHash = await sha256Hex(challenge);
  const rpId = new URL(request.url).hostname;

  await env.DB.prepare(
    `INSERT INTO auth_challenges (id, kind, target, secret_hash, user_id, attempts, expires_at, created_at)
     VALUES (?, 'passkey_register', ?, ?, ?, 0, ?, ?)`,
  )
    .bind(challengeId, displayName, secretHash, userId, nowMs + 5 * 60_000, nowMs)
    .run();

  const existingCreds = await env.DB.prepare("SELECT credential_id FROM passkeys WHERE user_id = ?")
    .bind(userId)
    .all<{ credential_id: string }>();
  const excludeCredentials = existingCreds.results.map((r) => ({ id: r.credential_id, type: "public-key" }));

  const publicKey = {
    challenge,
    rp: { name: "Selah Vault", id: rpId },
    user: {
      id: b64uEncode(new TextEncoder().encode(userId)),
      name: displayName,
      displayName,
    },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    timeout: 60_000,
    attestation: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    excludeCredentials,
  };
  return json({ challengeId, ...publicKey, publicKey });
}

async function handlePasskeyRegisterVerify(request: Request, env: AuthEnv, nowMs: number): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const cred = (body.credential && typeof body.credential === "object" ? body.credential : body) as Record<string, unknown>;
  const resp = (cred.response && typeof cred.response === "object" ? cred.response : {}) as Record<string, unknown>;
  if (typeof resp.clientDataJSON !== "string" || typeof resp.attestationObject !== "string") {
    return json({ error: "missing clientDataJSON or attestationObject" }, 400);
  }

  let clientData: { type?: string; challenge?: string; origin?: string };
  try {
    clientData = JSON.parse(new TextDecoder().decode(b64uDecode(resp.clientDataJSON)));
  } catch {
    return json({ error: "invalid clientDataJSON" }, 400);
  }
  const reqUrl = new URL(request.url);
  if (clientData.type !== "webauthn.create" || clientData.origin !== reqUrl.origin || typeof clientData.challenge !== "string") {
    return json({ error: "clientData verification failed" }, 401);
  }

  const secretHash = await sha256Hex(clientData.challenge);
  const chRow = await env.DB.prepare(
    "DELETE FROM auth_challenges WHERE kind = 'passkey_register' AND secret_hash = ? RETURNING user_id, target, expires_at",
  )
    .bind(secretHash)
    .first<{ user_id: string; target: string | null; expires_at: number }>();

  if (!chRow || chRow.expires_at <= nowMs) {
    return json({ error: "challenge expired or invalid" }, 401);
  }

  let att: { credentialId: string; signCount: number; jwk: JsonWebKey };
  try {
    att = await parseAttestation(resp.attestationObject, reqUrl.hostname);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "invalid attestation" }, 400);
  }
  if (typeof cred.id === "string" && cred.id !== att.credentialId) {
    return json({ error: "credential id mismatch" }, 400);
  }

  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : (chRow.target || "Personal");
  const userId = chRow.user_id;
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, apple_sub, name, created_at) VALUES (?, NULL, NULL, ?, ?)")
    .bind(userId, name, nowMs)
    .run();

  const transports = Array.isArray(resp.transports) ? JSON.stringify(resp.transports) : null;
  const passkeyName = defaultPasskeyName(request.headers.get("user-agent"));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO passkeys (credential_id, user_id, public_key, counter, transports, created_at, name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(att.credentialId, userId, JSON.stringify(att.jwk), att.signCount, transports, nowMs, passkeyName)
    .run();

  const userRow = await env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; email: string | null; name: string }>();
  return issueSessionResponse(env, request, userRow ?? { id: userId, email: null, name });
}

async function handlePasskeyLoginOptions(request: Request, env: AuthEnv, nowMs: number): Promise<Response> {
  const challenge = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challengeId = `ch_${b64uEncode(crypto.getRandomValues(new Uint8Array(12)))}`;
  const secretHash = await sha256Hex(challenge);
  const rpId = new URL(request.url).hostname;

  await env.DB.prepare(
    `INSERT INTO auth_challenges (id, kind, target, secret_hash, user_id, attempts, expires_at, created_at)
     VALUES (?, 'passkey_login', NULL, ?, NULL, 0, ?, ?)`,
  )
    .bind(challengeId, secretHash, nowMs + 5 * 60_000, nowMs)
    .run();

  const publicKey = {
    challenge,
    rpId,
    timeout: 60_000,
    userVerification: "preferred",
    allowCredentials: [],
  };
  return json({ challengeId, ...publicKey, publicKey });
}

async function handlePasskeyLoginVerify(request: Request, env: AuthEnv, nowMs: number): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const cred = (body.credential && typeof body.credential === "object" ? body.credential : body) as Record<string, unknown>;
  const resp = (cred.response && typeof cred.response === "object" ? cred.response : {}) as Record<string, unknown>;
  if (
    typeof cred.id !== "string" ||
    typeof resp.clientDataJSON !== "string" ||
    typeof resp.authenticatorData !== "string" ||
    typeof resp.signature !== "string"
  ) {
    return json({ error: "missing passkey assertion fields" }, 400);
  }

  const clientDataBytes = b64uDecode(resp.clientDataJSON);
  let clientData: { type?: string; challenge?: string; origin?: string };
  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
  } catch {
    return json({ error: "invalid clientDataJSON" }, 400);
  }
  const reqUrl = new URL(request.url);
  if (clientData.type !== "webauthn.get" || clientData.origin !== reqUrl.origin || typeof clientData.challenge !== "string") {
    return json({ error: "clientData verification failed" }, 401);
  }

  const secretHash = await sha256Hex(clientData.challenge);
  const chRow = await env.DB.prepare(
    "DELETE FROM auth_challenges WHERE kind = 'passkey_login' AND secret_hash = ? RETURNING expires_at",
  )
    .bind(secretHash)
    .first<{ expires_at: number }>();
  if (!chRow || chRow.expires_at <= nowMs) return json({ error: "challenge expired or invalid" }, 401);

  const pkRow = await env.DB.prepare("SELECT user_id, public_key, counter FROM passkeys WHERE credential_id = ?")
    .bind(cred.id)
    .first<{ user_id: string; public_key: string; counter: number }>();
  if (!pkRow) return json({ error: "unknown credential" }, 401);

  const authData = b64uDecode(resp.authenticatorData);
  if (authData.length < 37) return json({ error: "invalid authenticatorData" }, 400);
  const rpHash = await sha256Bytes(reqUrl.hostname);
  if (!equalBytes(authData.slice(0, 32), rpHash) || (authData[32] & 0x01) === 0) {
    return json({ error: "authenticatorData check failed" }, 401);
  }
  const signCount = ((authData[33] << 24) >>> 0) + ((authData[34] << 16) | (authData[35] << 8) | authData[36]);
  if ((pkRow.counter > 0 || signCount > 0) && signCount <= pkRow.counter) {
    return json({ error: "credential counter replay detected" }, 401);
  }

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(pkRow.public_key) as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const clientDataHash = await sha256Bytes(clientDataBytes);
    const signedData = new Uint8Array(authData.length + clientDataHash.length);
    signedData.set(authData, 0);
    signedData.set(clientDataHash, authData.length);
    const rawSig = derToP1363(b64uDecode(resp.signature));
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, rawSig as BufferSource, signedData as BufferSource);
    if (!ok) return json({ error: "invalid signature" }, 401);
  } catch {
    return json({ error: "invalid signature" }, 401);
  }

  if (signCount > pkRow.counter) {
    await env.DB.prepare("UPDATE passkeys SET counter = ? WHERE credential_id = ?").bind(signCount, cred.id).run();
  }
  const user = await env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?")
    .bind(pkRow.user_id)
    .first<{ id: string; email: string | null; name: string }>();
  if (!user) return json({ error: "user not found" }, 404);
  return issueSessionResponse(env, request, user);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when Email OTP can actually deliver a code (test hook or Resend secret). */
export function emailDeliveryConfigured(env: AuthEnv): boolean {
  return typeof env.sendEmail === "function" || Boolean(env.RESEND_API_KEY);
}

async function dispatchEmail(env: AuthEnv, msg: EmailMessage): Promise<void> {
  if (env.sendEmail) {
    await env.sendEmail(msg);
    return;
  }
  if (!env.RESEND_API_KEY) {
    throw new Error("email delivery is not configured");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: "Selah Vault <auth@selah.tools>",
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    }),
  });
  if (!res.ok) {
    throw new Error(`email provider returned ${res.status}`);
  }
}

async function handleEmailSend(request: Request, env: AuthEnv, nowMs: number): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "invalid email" }, 400);

  // Staging/workers.dev without RESEND_API_KEY must fail cleanly — never pretend to send.
  if (!emailDeliveryConfigured(env)) {
    return json({ error: "Email sign-in is not configured" }, 503);
  }

  const ip = clientIp(request);
  const emailLimit = await bumpRateLimit(
    env.DB,
    `email_send:${email}`,
    EMAIL_SEND_PER_EMAIL_MAX,
    EMAIL_SEND_WINDOW_MS,
    nowMs,
  );
  if (!emailLimit.ok) return json({ error: "too many codes for this email" }, 429);
  const ipLimit = await bumpRateLimit(
    env.DB,
    `email_send_ip:${ip}`,
    EMAIL_SEND_PER_IP_MAX,
    EMAIL_SEND_WINDOW_MS,
    nowMs,
  );
  if (!ipLimit.ok) return json({ error: "too many codes from this network" }, 429);

  const rand = crypto.getRandomValues(new Uint32Array(1))[0] % 900_000;
  const code = String(100_000 + rand);
  const secretHash = await sha256Hex(`${email}:${code}`);
  const expiresAt = nowMs + EMAIL_OTP_TTL_MS;

  // Resend updates the code in place and MUST preserve attempts so brute-force
  // progress is not reset by requesting a fresh email.
  const existing = await env.DB.prepare(
    "SELECT id, attempts, expires_at FROM auth_challenges WHERE kind = 'email_otp' AND target = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(email)
    .first<{ id: string; attempts: number; expires_at: number }>();

  if (existing && existing.attempts >= EMAIL_VERIFY_MAX_ATTEMPTS) {
    return json({ error: "too many verification attempts; try again later" }, 429);
  }

  if (existing && existing.expires_at > nowMs) {
    await env.DB.prepare("UPDATE auth_challenges SET secret_hash = ?, expires_at = ? WHERE id = ?")
      .bind(secretHash, expiresAt, existing.id)
      .run();
  } else {
    if (existing) {
      await env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(existing.id).run();
    }
    const id = `otp_${b64uEncode(crypto.getRandomValues(new Uint8Array(12)))}`;
    await env.DB.prepare(
      `INSERT INTO auth_challenges (id, kind, target, secret_hash, user_id, attempts, expires_at, created_at)
       VALUES (?, 'email_otp', ?, ?, NULL, 0, ?, ?)`,
    )
      .bind(id, email, secretHash, expiresAt, nowMs)
      .run();
  }

  try {
    const mail = signInCodeEmail(code);
    await dispatchEmail(env, {
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      code,
    });
  } catch {
    return json({ error: "Email sign-in is not configured" }, 503);
  }
  return json({ sent: true });
}

async function handleEmailVerify(request: Request, env: AuthEnv, nowMs: number): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return json({ error: "invalid email or code" }, 400);

  const session = await verifyBearerOrCookie(env, request);
  if (session) {
    const csrf = cookieWriteOriginError(request);
    if (csrf) return json({ error: csrf }, 403);
  }

  const verifyLimit = await bumpRateLimit(
    env.DB,
    `email_verify:${email}`,
    EMAIL_VERIFY_PER_EMAIL_MAX,
    EMAIL_VERIFY_WINDOW_MS,
    nowMs,
  );
  if (!verifyLimit.ok) return json({ error: "too many verification attempts" }, 429);

  const row = await env.DB.prepare(
    "SELECT id, secret_hash, attempts, expires_at FROM auth_challenges WHERE kind = 'email_otp' AND target = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(email)
    .first<{ id: string; secret_hash: string; attempts: number; expires_at: number }>();

  if (!row || row.expires_at <= nowMs || row.attempts >= EMAIL_VERIFY_MAX_ATTEMPTS) {
    return json({ error: "code expired or invalid" }, 401);
  }
  const expectedHash = await sha256Hex(`${email}:${code}`);
  if (row.secret_hash !== expectedHash) {
    await env.DB.prepare("UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
    return json({ error: "code invalid" }, 401);
  }
  await env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(row.id).run();

  // Linking never merges two existing accounts (each user owns its own LibraryDO).
  // If this email already belongs to someone else, return 409 and leave both accounts alone.
  if (session) {
    const taken = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind(email)
      .first<{ id: string }>();
    if (taken && taken.id !== session.parsed.userId) {
      return json({ error: LINKED_ELSEWHERE }, 409);
    }
    await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, session.parsed.userId).run();
    const user = await env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?")
      .bind(session.parsed.userId)
      .first<{ id: string; email: string | null; name: string }>();
    if (!user) return json({ error: "user not found" }, 404);
    return issueSessionResponse(env, request, user);
  }

  let user = await env.DB.prepare("SELECT id, email, name FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; email: string | null; name: string }>();
  if (!user) {
    const id = newUserId();
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Personal";
    await env.DB.prepare("INSERT INTO users (id, email, apple_sub, name, created_at) VALUES (?, ?, NULL, ?, ?)")
      .bind(id, email, name, nowMs)
      .run();
    user = { id, email, name };
  }
  return issueSessionResponse(env, request, user);
}

async function handleAppleAuth(request: Request, env: AuthEnv, nowMs: number): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const session = await verifyBearerOrCookie(env, request);
  if (session) {
    const csrf = cookieWriteOriginError(request);
    if (csrf) return json({ error: csrf }, 403);
  }

  const idToken = typeof body.id_token === "string" ? body.id_token : typeof body.identityToken === "string" ? body.identityToken : "";
  const parts = idToken.split(".");
  if (parts.length !== 3) return json({ error: "invalid id_token format" }, 400);

  let header: { alg?: string; kid?: string };
  let payload: { iss?: string; aud?: string; sub?: string; email?: string; email_verified?: boolean | string; exp?: number };
  try {
    header = JSON.parse(new TextDecoder().decode(b64uDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64uDecode(parts[1])));
  } catch {
    return json({ error: "malformed JWT" }, 400);
  }
  const nowSec = Math.floor(nowMs / 1000);
  if (header.alg !== "RS256" || !header.kid || payload.iss !== "https://appleid.apple.com" || !payload.sub || !payload.exp || payload.exp <= nowSec) {
    return json({ error: "invalid Apple token claims" }, 401);
  }
  // Apple sign-in is disabled unless APPLE_CLIENT_ID is configured. Never skip the audience check.
  if (!env.APPLE_CLIENT_ID) {
    return json({ error: "Apple sign-in is not configured" }, 503);
  }
  if (payload.aud !== env.APPLE_CLIENT_ID) {
    return json({ error: "Apple token audience mismatch" }, 401);
  }

  try {
    const fetcher = env.fetchJwks ?? fetch;
    const jwksRes = await fetcher("https://appleid.apple.com/auth/keys");
    if (!jwksRes.ok) return json({ error: "unable to fetch Apple JWKS" }, 502);
    const jwks = (await jwksRes.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    const jwk = jwks.keys?.find((k) => k.kid === header.kid);
    if (!jwk) return json({ error: "unknown Apple signing key" }, 401);
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sig = b64uDecode(parts[2]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sig as BufferSource, signed as BufferSource);
    if (!valid) return json({ error: "invalid Apple signature" }, 401);
  } catch {
    return json({ error: "Apple signature verification failed" }, 401);
  }

  const sub = payload.sub;
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null;

  if (session) {
    const bySub = await env.DB.prepare("SELECT id FROM users WHERE apple_sub = ?")
      .bind(sub)
      .first<{ id: string }>();
    if (bySub && bySub.id !== session.parsed.userId) {
      return json({ error: LINKED_ELSEWHERE }, 409);
    }
    if (email) {
      const byEmail = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
        .bind(email)
        .first<{ id: string }>();
      if (byEmail && byEmail.id !== session.parsed.userId) {
        return json({ error: LINKED_ELSEWHERE }, 409);
      }
    }
    const current = await env.DB.prepare("SELECT email, name FROM users WHERE id = ?")
      .bind(session.parsed.userId)
      .first<{ email: string | null; name: string }>();
    if (!current) return json({ error: "user not found" }, 404);
    // Attach Apple to this account. Keep an existing email — Apple's Hide My Email
    // relay must not silently replace a verified address. Fill email only when unset.
    if (!current.email && email) {
      await env.DB.prepare("UPDATE users SET apple_sub = ?, email = ? WHERE id = ?")
        .bind(sub, email, session.parsed.userId)
        .run();
    } else {
      await env.DB.prepare("UPDATE users SET apple_sub = ? WHERE id = ?").bind(sub, session.parsed.userId).run();
    }
    return issueSessionResponse(env, request, {
      id: session.parsed.userId,
      email: current.email ?? email,
      name: current.name,
    });
  }

  let user = await env.DB.prepare("SELECT id, email, name FROM users WHERE apple_sub = ?")
    .bind(sub)
    .first<{ id: string; email: string | null; name: string }>();

  if (!user && email && (payload.email_verified === true || payload.email_verified === "true")) {
    const byEmail = await env.DB.prepare("SELECT id, email, name FROM users WHERE email = ?")
      .bind(email)
      .first<{ id: string; email: string | null; name: string }>();
    if (byEmail) {
      await env.DB.prepare("UPDATE users SET apple_sub = ? WHERE id = ?").bind(sub, byEmail.id).run();
      user = byEmail;
    }
  }
  if (!user) {
    const id = newUserId();
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Personal";
    await env.DB.prepare("INSERT INTO users (id, email, apple_sub, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, email, sub, name, nowMs)
      .run();
    user = { id, email, name };
  }
  return issueSessionResponse(env, request, user);
}

const LINKED_ELSEWHERE = "already linked to another account";
const LAST_METHOD_ERROR = "cannot remove the last sign-in method";

function parseTransports(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function credentialSuffix(id: string): string {
  const compact = id.replace(/[^A-Za-z0-9]/g, "");
  const src = compact || id;
  return src.slice(-8);
}

export const PASSKEY_NAME_MAX = 40;

function browserFromUserAgent(ua: string): string | null {
  if (/Edg(?:e|A|iOS)?\//i.test(ua) || /Edg\//i.test(ua)) return "Edge";
  if (/OPR\/|Opera\//i.test(ua)) return "Opera";
  if (/Chrome\/|CriOS\//i.test(ua)) return "Chrome";
  if (/Firefox\/|FxiOS\//i.test(ua)) return "Firefox";
  if (/Safari\//i.test(ua)) return "Safari";
  return null;
}

/** Sensible default passkey name from a User-Agent, e.g. "iPhone" or "Mac · Safari". */
export function defaultPasskeyName(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = browserFromUserAgent(ua);
  let name = "Passkey";
  if (/iPhone/i.test(ua)) name = "iPhone";
  else if (/iPad/i.test(ua)) name = "iPad";
  else if (/Macintosh|Mac OS X/i.test(ua)) name = browser ? `Mac · ${browser}` : "Mac";
  else if (/Windows/i.test(ua)) name = browser ? `Windows · ${browser}` : "Windows";
  else if (/Android/i.test(ua)) name = browser ? `Android · ${browser}` : "Android";
  else if (/CrOS/i.test(ua)) name = browser ? `Chrome OS · ${browser}` : "Chrome OS";
  else if (/Linux/i.test(ua)) name = browser ? `Linux · ${browser}` : "Linux";
  else if (browser) name = browser;
  return name.slice(0, PASSKEY_NAME_MAX);
}

export function parsePasskeyDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length < 1 || name.length > PASSKEY_NAME_MAX) return null;
  return name;
}

async function countSignInMethods(db: D1Database, userId: string): Promise<number> {
  const user = await db
    .prepare("SELECT email, apple_sub FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email: string | null; apple_sub: string | null }>();
  const passkeys = await db
    .prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return (user?.email ? 1 : 0) + (user?.apple_sub ? 1 : 0) + (passkeys?.n ?? 0);
}

type OwnerAuth =
  | { verified: NonNullable<Awaited<ReturnType<typeof verifyBearerOrCookie>>> }
  | { error: Response };

async function requireOwnerSession(env: AuthEnv, request: Request): Promise<OwnerAuth> {
  const csrf = cookieWriteOriginError(request);
  if (csrf) return { error: json({ error: csrf }, 403) };
  const verified = await verifyBearerOrCookie(env, request);
  if (!verified) return { error: json({ error: "unauthorized" }, 401) };
  if (!verified.scopes.includes("*")) return { error: json({ error: "owner session required" }, 403) };
  return { verified };
}

async function methodsPayload(env: AuthEnv, userId: string) {
  const user = await env.DB.prepare("SELECT email, apple_sub FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email: string | null; apple_sub: string | null }>();
  const passkeys = await env.DB.prepare(
    "SELECT credential_id, transports, created_at, name FROM passkeys WHERE user_id = ? ORDER BY created_at ASC",
  )
    .bind(userId)
    .all<{ credential_id: string; transports: string | null; created_at: number; name: string | null }>();
  return {
    email: user?.email ?? null,
    apple: Boolean(user?.apple_sub),
    appleConfigured: Boolean(env.APPLE_CLIENT_ID),
    emailConfigured: emailDeliveryConfigured(env),
    passkeys: passkeys.results.map((row) => ({
      id: row.credential_id,
      suffix: credentialSuffix(row.credential_id),
      name: row.name ?? null,
      created_at: row.created_at,
      transports: parseTransports(row.transports),
    })),
  };
}

async function handleMethodsGet(request: Request, env: AuthEnv): Promise<Response> {
  const auth = await requireOwnerSession(env, request);
  if ("error" in auth) return auth.error;
  return json(await methodsPayload(env, auth.verified.parsed.userId));
}

async function handleMethodsRemove(request: Request, env: AuthEnv): Promise<Response> {
  const auth = await requireOwnerSession(env, request);
  if ("error" in auth) return auth.error;
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const type = typeof body.type === "string" ? body.type : typeof body.method === "string" ? body.method : "";
  const userId = auth.verified.parsed.userId;
  if ((await countSignInMethods(env.DB, userId)) <= 1) {
    return json({ error: LAST_METHOD_ERROR }, 400);
  }

  if (type === "email") {
    const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?")
      .bind(userId)
      .first<{ email: string | null }>();
    if (!row?.email) return json({ error: "email is not linked" }, 400);
    await env.DB.prepare("UPDATE users SET email = NULL WHERE id = ?").bind(userId).run();
  } else if (type === "apple") {
    const row = await env.DB.prepare("SELECT apple_sub FROM users WHERE id = ?")
      .bind(userId)
      .first<{ apple_sub: string | null }>();
    if (!row?.apple_sub) return json({ error: "Apple is not linked" }, 400);
    await env.DB.prepare("UPDATE users SET apple_sub = NULL WHERE id = ?").bind(userId).run();
  } else if (type === "passkey") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return json({ error: "missing passkey id" }, 400);
    const row = await env.DB.prepare("SELECT credential_id FROM passkeys WHERE credential_id = ? AND user_id = ?")
      .bind(id, userId)
      .first<{ credential_id: string }>();
    if (!row) return json({ error: "passkey not found" }, 404);
    await env.DB.prepare("DELETE FROM passkeys WHERE credential_id = ? AND user_id = ?").bind(id, userId).run();
  } else {
    return json({ error: "unknown method type" }, 400);
  }
  return json(await methodsPayload(env, userId));
}

async function handleMethodsRename(request: Request, env: AuthEnv): Promise<Response> {
  const auth = await requireOwnerSession(env, request);
  if ("error" in auth) return auth.error;
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const credentialId = typeof body.credentialId === "string" ? body.credentialId : typeof body.id === "string" ? body.id : "";
  if (!credentialId) return json({ error: "missing passkey id" }, 400);
  const name = parsePasskeyDisplayName(body.name);
  if (!name) return json({ error: "name must be 1–40 characters" }, 400);
  const userId = auth.verified.parsed.userId;
  const row = await env.DB.prepare("SELECT credential_id FROM passkeys WHERE credential_id = ? AND user_id = ?")
    .bind(credentialId, userId)
    .first<{ credential_id: string }>();
  if (!row) return json({ error: "passkey not found" }, 404);
  await env.DB.prepare("UPDATE passkeys SET name = ? WHERE credential_id = ? AND user_id = ?")
    .bind(name, credentialId, userId)
    .run();
  return json(await methodsPayload(env, userId));
}

async function handleMe(request: Request, env: AuthEnv): Promise<Response> {
  const verified = await verifyBearerOrCookie(env, request);
  if (!verified) return json({ error: "unauthorized" }, 401);
  const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(verified.parsed.userId)
    .first<{ email: string | null }>();
  return json({
    user: {
      id: verified.parsed.userId,
      email: row?.email ?? null,
      name: verified.library.name,
    },
    scopes: verified.scopes,
  });
}

async function handleLogout(request: Request, env: AuthEnv): Promise<Response> {
  const parsed = extractTokenFromRequest(request, false);
  if (parsed) {
    const secretHash = await sha256Hex(parsed.secret);
    await callLibraryInternal(env, parsed.userId, "/_internal/revoke", { secretHash });
  }
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookieHeader(request.url) });
}

const STATE_RE = /^[A-Za-z0-9_.-]{8,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9_.~-]{43,128}$/;

function buildRedirectUrl(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export function oauthMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SCOPES],
  };
}

function handleAuthorizeGet(request: Request, env: AuthEnv, url: URL): Promise<Response> | Response {
  const accept = request.headers.get("accept") ?? "";
  if (env.ASSETS && !accept.includes("application/json")) {
    // Fetch the extensionless Assets path. Asking for /connect.html makes Assets
    // 307 → /connect, which is runWorkerFirst and loops forever.
    return fetchStaticAsset(env.ASSETS, request, "/connect");
  }
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const responseType = url.searchParams.get("response_type") ?? "";
  const scopeRaw = url.searchParams.get("scope") ?? "read";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const challengeMethod = url.searchParams.get("code_challenge_method") ?? "";
  const state = url.searchParams.get("state") ?? "";

  const client = validateOAuthClient(clientId, redirectUri);
  if (!client) return json({ error: "invalid_client", error_description: "disallowed client_id or redirect_uri" }, 400);
  if (responseType !== "code") return json({ error: "unsupported_response_type" }, 400);
  const scopes = parseScopes(scopeRaw);
  if (!scopes) return json({ error: "invalid_scope" }, 400);
  if (challengeMethod !== "S256" || !CHALLENGE_RE.test(codeChallenge)) {
    return json({ error: "invalid_request", error_description: "PKCE S256 code_challenge required" }, 400);
  }
  if (!STATE_RE.test(state)) {
    return json({ error: "invalid_request", error_description: "state must be 8..128 [A-Za-z0-9_.-] chars" }, 400);
  }
  return json({ client, client_id: clientId, redirect_uri: redirectUri, scopes, state });
}

async function handleAuthorizePost(request: Request, env: AuthEnv, nowMs: number): Promise<Response> {
  const verified = await verifyBearerOrCookie(env, request);
  if (!verified) return json({ error: "unauthorized" }, 401);
  if (!verified.scopes.includes("*")) return json({ error: "owner session required" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const clientId = String(body.client_id ?? "");
  const redirectUri = String(body.redirect_uri ?? "");
  const codeChallenge = String(body.code_challenge ?? "");
  const challengeMethod = String(body.code_challenge_method ?? "");
  const state = String(body.state ?? "");
  const approve = Boolean(body.approve);

  const client = validateOAuthClient(clientId, redirectUri);
  if (!client) return json({ error: "invalid_client" }, 403);
  const scopes = parseScopes(body.scope ?? "read");
  if (!scopes) return json({ error: "invalid_scope" }, 400);
  if (challengeMethod !== "S256" || !CHALLENGE_RE.test(codeChallenge)) {
    return json({ error: "invalid_request", error_description: "PKCE S256 required" }, 400);
  }
  if (!STATE_RE.test(state)) {
    return json({ error: "invalid_request", error_description: "invalid state" }, 400);
  }

  if (!approve) {
    return json({ redirect_to: buildRedirectUrl(redirectUri, { error: "access_denied", state }) });
  }

  const code = newSecret();
  const codeHash = await sha256Hex(code);
  await env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, scopes, code_challenge, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(codeHash, verified.parsed.userId, clientId, redirectUri, scopes.join(" "), codeChallenge, nowMs + OAUTH_CODE_TTL_MS, nowMs)
    .run();

  return json({ redirect_to: buildRedirectUrl(redirectUri, { code, state }) });
}

async function parseJsonOrForm(request: Request): Promise<Record<string, string> | null> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  const text = await request.text();
  if (!text) return {};
  if (ct.includes("application/x-www-form-urlencoded")) {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    return out;
  }
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = String(v);
    return out;
  } catch {
    return null;
  }
}

async function handleOAuthToken(request: Request, env: AuthEnv, nowMs: number): Promise<Response> {
  const body = await parseJsonOrForm(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  if (body.grant_type !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);

  const { code = "", redirect_uri = "", client_id = "", code_verifier = "" } = body;
  if (!code || !redirect_uri || !client_id || !VERIFIER_RE.test(code_verifier)) {
    return json({ error: "invalid_request" }, 400);
  }
  const codeHash = await sha256Hex(code);
  const row = await env.DB.prepare(
    "DELETE FROM oauth_codes WHERE code_hash = ? RETURNING user_id, client_id, redirect_uri, scopes, code_challenge, expires_at",
  )
    .bind(codeHash)
    .first<{
      user_id: string;
      client_id: string;
      redirect_uri: string;
      scopes: string;
      code_challenge: string;
      expires_at: number;
    }>();

  if (!row || row.expires_at <= nowMs || row.client_id !== client_id || row.redirect_uri !== redirect_uri) {
    return json({ error: "invalid_grant" }, 400);
  }
  const verifierChallenge = await sha256B64u(code_verifier);
  if (verifierChallenge !== row.code_challenge) {
    return json({ error: "invalid_grant" }, 400);
  }

  const token = makeToken(row.user_id);
  const secretHash = await sha256Hex(token.secret);
  const userRow = await env.DB.prepare("SELECT name FROM users WHERE id = ?")
    .bind(row.user_id)
    .first<{ name: string }>();

  const regRes = await callLibraryInternal(env, row.user_id, "/_internal/tokens", {
    name: userRow?.name ?? "Personal",
    secretHash,
    scopes: row.scopes.split(" ").filter(Boolean),
    clientId: row.client_id,
    ttlSec: OAUTH_GRANT_TTL_SEC,
  });
  const reg = (await regRes.json()) as { library?: { id: string; name: string } };
  const libName = reg.library?.name ?? userRow?.name ?? "Personal";

  return json({
    access_token: token.raw,
    token_type: "Bearer",
    expires_in: OAUTH_GRANT_TTL_SEC,
    scope: row.scopes,
    user: { id: row.user_id, name: libName },
  });
}

async function handleOAuthRevoke(request: Request, env: AuthEnv): Promise<Response> {
  let parsed = extractTokenFromRequest(request, false);
  if (!parsed) {
    const body = await parseJsonOrForm(request);
    if (body?.token) parsed = parseToken(body.token);
  }
  if (parsed) {
    const secretHash = await sha256Hex(parsed.secret);
    await callLibraryInternal(env, parsed.userId, "/_internal/revoke", { secretHash });
  }
  return json({});
}

export async function handleAuthAndOAuth(request: Request, env: AuthEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const nowMs = env.now ? env.now() : Date.now();

  if (method === "OPTIONS" && (path.startsWith("/auth/") || path.startsWith("/oauth/") || path === "/.well-known/oauth-authorization-server" || path === "/connect")) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (path === "/.well-known/oauth-authorization-server" && (method === "GET" || method === "HEAD")) {
    return json(oauthMetadata(url.origin));
  }
  if ((path === "/oauth/authorize" || path === "/connect") && (method === "GET" || method === "HEAD")) {
    return handleAuthorizeGet(request, env, url);
  }
  if (path === "/oauth/authorize" && method === "POST") return handleAuthorizePost(request, env, nowMs);
  if (path === "/oauth/token" && method === "POST") return handleOAuthToken(request, env, nowMs);
  if (path === "/oauth/revoke" && method === "POST") return handleOAuthRevoke(request, env);

  if (path === "/auth/passkey/register/options" && method === "POST") return handlePasskeyRegisterOptions(request, env, nowMs);
  if (path === "/auth/passkey/register/verify" && method === "POST") return handlePasskeyRegisterVerify(request, env, nowMs);
  if (path === "/auth/passkey/login/options" && method === "POST") return handlePasskeyLoginOptions(request, env, nowMs);
  if (path === "/auth/passkey/login/verify" && method === "POST") return handlePasskeyLoginVerify(request, env, nowMs);
  if (path === "/auth/email/send" && method === "POST") return handleEmailSend(request, env, nowMs);
  if (path === "/auth/email/verify" && method === "POST") return handleEmailVerify(request, env, nowMs);
  if (path === "/auth/apple" && method === "POST") return handleAppleAuth(request, env, nowMs);
  if (path === "/auth/me" && method === "GET") return handleMe(request, env);
  if (path === "/auth/logout" && method === "POST") return handleLogout(request, env);
  if (path === "/auth/methods" && method === "GET") return handleMethodsGet(request, env);
  if (path === "/auth/methods" && method === "DELETE") return handleMethodsRemove(request, env);
  if (path === "/auth/methods/remove" && method === "POST") return handleMethodsRemove(request, env);
  if (path === "/auth/methods/rename" && method === "POST") return handleMethodsRename(request, env);

  return null;
}
