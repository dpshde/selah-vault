import { describe, expect, test } from "bun:test";
import { TOKEN_RE, USER_ID_RE, b64uDecode, b64uEncode, sha256B64u, sha256Bytes } from "../src/clients";
import { TEST_ORIGIN, createTestEnv } from "./env";

// Minimal CBOR encoder for constructing real WebAuthn attestationObject payloads in tests.
function cborUint(major: number, n: number): number[] {
  const mt = major << 5;
  if (n < 24) return [mt | n];
  if (n < 256) return [mt | 24, n];
  return [mt | 25, (n >> 8) & 0xff, n & 0xff];
}

function cborEncode(val: unknown): Uint8Array {
  if (typeof val === "number") {
    return val >= 0 ? new Uint8Array(cborUint(0, val)) : new Uint8Array(cborUint(1, -1 - val));
  }
  if (val instanceof Uint8Array) {
    return new Uint8Array([...cborUint(2, val.length), ...val]);
  }
  if (typeof val === "string") {
    const b = new TextEncoder().encode(val);
    return new Uint8Array([...cborUint(3, b.length), ...b]);
  }
  if (val instanceof Map) {
    const parts: number[] = [...cborUint(5, val.size)];
    for (const [k, v] of val.entries()) {
      parts.push(...cborEncode(k), ...cborEncode(v));
    }
    return new Uint8Array(parts);
  }
  throw new Error("unsupported cbor test type");
}

// Converts raw 64-byte WebCrypto P1363 ECDSA signature to ASN.1 DER as authenticators emit.
function p1363ToDer(raw: Uint8Array): Uint8Array {
  const intDer = (slice: Uint8Array): number[] => {
    let i = 0;
    while (i < slice.length - 1 && slice[i] === 0) i++;
    const trimmed = slice.slice(i);
    const body = trimmed[0] & 0x80 ? [0x00, ...trimmed] : [...trimmed];
    return [0x02, body.length, ...body];
  };
  const r = intDer(raw.slice(0, 32));
  const s = intDer(raw.slice(32, 64));
  const seq = [...r, ...s];
  return new Uint8Array([0x30, seq.length, ...seq]);
}

describe("Email OTP & Session Lifecycle", () => {
  test("issues sv2.<userId>.<secret> token and HttpOnly selah_session cookie, verifies /auth/me and /auth/logout", async () => {
    const h = createTestEnv();
    const sendRes = await h.fetch("/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Reader@Selah.Tools" }),
    });
    expect(sendRes.status).toBe(200);
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0].to).toBe("reader@selah.tools");
    expect(h.emails[0].code).toMatch(/^\d{6}$/);

    // Wrong OTP increments attempts and returns 401
    const badRes = await h.fetch("/auth/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@selah.tools", code: "000000" }),
    });
    expect(badRes.status).toBe(401);

    // Valid OTP succeeds
    const verifyRes = await h.fetch("/auth/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@selah.tools", code: h.emails[0].code, name: "Study" }),
    });
    expect(verifyRes.status).toBe(200);
    const session = (await verifyRes.json()) as { token: string; user: { id: string; email: string; name: string } };
    expect(session.token).toMatch(TOKEN_RE);
    expect(session.user.id).toMatch(USER_ID_RE);
    expect(session.user.email).toBe("reader@selah.tools");
    expect(session.user.name).toBe("Study");

    const setCookie = verifyRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("selah_session=sv2.");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");

    const cookiePair = setCookie.split(";")[0];
    const meRes = await h.fetch("/auth/me", { headers: { cookie: cookiePair } });
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toEqual({
      user: { id: session.user.id, email: "reader@selah.tools", name: "Study" },
      scopes: ["*"],
    });

    const outRes = await h.fetch("/auth/logout", { method: "POST", headers: { cookie: cookiePair } });
    expect(outRes.status).toBe(200);
    expect((await h.fetch("/auth/me", { headers: { cookie: cookiePair } })).status).toBe(401);
  });

  test("rate-limits OTP sends per email and per IP, and resend preserves the attempt counter", async () => {
    const h = createTestEnv();
    const email = "rate@selah.tools";
    const send = (ip: string) =>
      h.fetch("/auth/email/send", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ email }),
      });

    expect((await send("203.0.113.10")).status).toBe(200);
    const firstCode = h.emails[0]!.code;

    // Burn four verify attempts against the first code.
    for (let i = 0; i < 4; i++) {
      expect(
        (
          await h.fetch("/auth/email/verify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, code: "000000" }),
          })
        ).status,
      ).toBe(401);
    }

    // Resend must keep attempts=4 so one more failure locks the challenge.
    expect((await send("203.0.113.10")).status).toBe(200);
    expect(h.emails).toHaveLength(2);
    expect(h.emails[1]!.code).not.toBe(firstCode);

    expect(
      (
        await h.fetch("/auth/email/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, code: "000000" }),
        })
      ).status,
    ).toBe(401);

    // Fifth failure exhausted attempts; even the latest code is rejected.
    const locked = await h.fetch("/auth/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code: h.emails[1]!.code }),
    });
    expect(locked.status).toBe(401);

    // Further resends while locked out are refused.
    expect((await send("203.0.113.10")).status).toBe(429);

    // Per-email send cap (5/hour) on a fresh email.
    const capped = "capped@selah.tools";
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await h.fetch("/auth/email/send", {
            method: "POST",
            headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" },
            body: JSON.stringify({ email: capped }),
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await h.fetch("/auth/email/send", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" },
          body: JSON.stringify({ email: capped }),
        })
      ).status,
    ).toBe(429);

    // Per-IP send cap across distinct emails.
    const ip = "198.51.100.99";
    for (let i = 0; i < 20; i++) {
      const res = await h.fetch("/auth/email/send", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ email: `ip${i}@selah.tools` }),
      });
      expect(res.status).toBe(200);
    }
    expect(
      (
        await h.fetch("/auth/email/send", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": ip },
          body: JSON.stringify({ email: "ip-overflow@selah.tools" }),
        })
      ).status,
    ).toBe(429);
  });
});

describe("WebAuthn Passkeys (ES256 P-256)", () => {
  test("registers a P-256 passkey, logs in with DER ECDSA signature, and blocks counter replay", async () => {
    const h = createTestEnv();
    const optRes = await h.fetch("/auth/passkey/register/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "My Passkey Vault" }),
    });
    expect(optRes.status).toBe(200);
    const opts = (await optRes.json()) as { challenge: string; rp: { id: string } };

    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const credIdBytes = crypto.getRandomValues(new Uint8Array(20));
    const credId = b64uEncode(credIdBytes);

    const coseKey = new Map<unknown, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, b64uDecode(jwk.x!)],
      [-3, b64uDecode(jwk.y!)],
    ]);
    const coseBytes = cborEncode(coseKey);
    const rpHash = await sha256Bytes("vault.selah.tools");
    const authData = new Uint8Array(55 + credIdBytes.length + coseBytes.length);
    authData.set(rpHash, 0);
    authData[32] = 0x45; // UP (0x01) | UV (0x04) | AT (0x40)
    authData[36] = 1; // signCount = 1
    authData[53] = 0;
    authData[54] = credIdBytes.length;
    authData.set(credIdBytes, 55);
    authData.set(coseBytes, 55 + credIdBytes.length);

    const attObj = cborEncode(new Map<unknown, unknown>([["fmt", "none"], ["authData", authData]]));
    const clientDataReg = b64uEncode(
      new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin: TEST_ORIGIN })),
    );

    const regRes = await h.fetch("/auth/passkey/register/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credential: {
          id: credId,
          type: "public-key",
          response: { clientDataJSON: clientDataReg, attestationObject: b64uEncode(attObj), transports: ["internal"] },
        },
      }),
    });
    expect(regRes.status).toBe(200);
    const regBody = (await regRes.json()) as { token: string; user: { id: string; name: string } };
    expect(regBody.token).toMatch(TOKEN_RE);

    // Login ceremony with signCount = 2
    const loginOptsRes = await h.fetch("/auth/passkey/login/options", { method: "POST" });
    const loginOpts = (await loginOptsRes.json()) as { challenge: string };
    const clientDataLoginBytes = new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.get", challenge: loginOpts.challenge, origin: TEST_ORIGIN }),
    );
    const loginAuthData = new Uint8Array(37);
    loginAuthData.set(rpHash, 0);
    loginAuthData[32] = 0x05;
    loginAuthData[36] = 2; // signCount = 2 > 1
    const clientHash = await sha256Bytes(clientDataLoginBytes);
    const signedPayload = new Uint8Array(37 + 32);
    signedPayload.set(loginAuthData, 0);
    signedPayload.set(clientHash, 37);

    const p1363Sig = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, signedPayload),
    );
    const derSig = p1363ToDer(p1363Sig);

    const loginRes = await h.fetch("/auth/passkey/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credential: {
          id: credId,
          response: {
            clientDataJSON: b64uEncode(clientDataLoginBytes),
            authenticatorData: b64uEncode(loginAuthData),
            signature: b64uEncode(derSig),
          },
        },
      }),
    });
    expect(loginRes.status).toBe(200);
    expect(((await loginRes.json()) as { user: { id: string } }).user.id).toBe(regBody.user.id);

    // Counter replay (signCount = 2 <= stored 2) fails with 401
    const replayOpts = (await (await h.fetch("/auth/passkey/login/options", { method: "POST" })).json()) as { challenge: string };
    const replayClient = new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.get", challenge: replayOpts.challenge, origin: TEST_ORIGIN }),
    );
    const replayPayload = new Uint8Array(69);
    replayPayload.set(loginAuthData, 0);
    replayPayload.set(await sha256Bytes(replayClient), 37);
    const replaySig = p1363ToDer(
      new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, replayPayload)),
    );
    const replayRes = await h.fetch("/auth/passkey/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credential: {
          id: credId,
          response: {
            clientDataJSON: b64uEncode(replayClient),
            authenticatorData: b64uEncode(loginAuthData),
            signature: b64uEncode(replaySig),
          },
        },
      }),
    });
    expect(replayRes.status).toBe(401);
  });
});

describe("Staging without RESEND_API_KEY / APPLE_CLIENT_ID", () => {
  test("email OTP returns clear 503, Apple returns 503, and passkey sign-up still works", async () => {
    // Mimic workers.dev staging: no email provider, no Apple client id, no sendEmail hook.
    const h = createTestEnv({
      sendEmail: undefined,
      RESEND_API_KEY: undefined,
      APPLE_CLIENT_ID: undefined,
    });

    const emailRes = await h.fetch("/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "staging@selah.tools" }),
    });
    expect(emailRes.status).toBe(503);
    expect(await emailRes.json()).toEqual({ error: "Email sign-in is not configured" });
    expect(h.emails).toHaveLength(0);

    const appleRes = await h.fetch("/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id_token: `${b64uEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "k" })))}.${b64uEncode(new TextEncoder().encode(JSON.stringify({ iss: "https://appleid.apple.com", aud: "x", sub: "s", exp: Math.floor(h.now / 1000) + 60 })))}.sig`,
      }),
    });
    expect(appleRes.status).toBe(503);
    expect(await appleRes.json()).toEqual({ error: "Apple sign-in is not configured" });

    // Passkey registration must not depend on either secret.
    const optRes = await h.fetch("/auth/passkey/register/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Staging Passkey" }),
    });
    expect(optRes.status).toBe(200);
    const opts = (await optRes.json()) as { challenge: string };

    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const credIdBytes = crypto.getRandomValues(new Uint8Array(20));
    const credId = b64uEncode(credIdBytes);
    const coseKey = new Map<unknown, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, b64uDecode(jwk.x!)],
      [-3, b64uDecode(jwk.y!)],
    ]);
    const coseBytes = cborEncode(coseKey);
    const rpHash = await sha256Bytes("vault.selah.tools");
    const authData = new Uint8Array(55 + credIdBytes.length + coseBytes.length);
    authData.set(rpHash, 0);
    authData[32] = 0x45;
    authData[36] = 1;
    authData[53] = 0;
    authData[54] = credIdBytes.length;
    authData.set(credIdBytes, 55);
    authData.set(coseBytes, 55 + credIdBytes.length);
    const attObj = cborEncode(new Map<unknown, unknown>([["fmt", "none"], ["authData", authData]]));
    const clientDataReg = b64uEncode(
      new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin: TEST_ORIGIN })),
    );
    const regRes = await h.fetch("/auth/passkey/register/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credential: {
          id: credId,
          type: "public-key",
          response: { clientDataJSON: clientDataReg, attestationObject: b64uEncode(attObj), transports: ["internal"] },
        },
      }),
    });
    expect(regRes.status).toBe(200);
    const session = (await regRes.json()) as { token: string; user: { name: string } };
    expect(session.token).toMatch(TOKEN_RE);
    expect(session.user.name).toBe("Staging Passkey");
    expect((await h.fetch("/v2/bootstrap", { headers: { authorization: `Bearer ${session.token}` } })).status).toBe(200);
  });
});

describe("Sign in with Apple (RS256 JWKS)", () => {
  test("verifies Apple RS256 id_token against JWKS and links verified email accounts", async () => {
    const rsa = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const pubJwk = await crypto.subtle.exportKey("jwk", rsa.publicKey);
    const h = createTestEnv({
      APPLE_CLIENT_ID: "tools.selah.vault",
      fetchJwks: (async () =>
        new Response(JSON.stringify({ keys: [{ ...pubJwk, kid: "apple-k1", alg: "RS256", use: "sig" }] }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

    const existing = await h.createUserSession("shared@selah.tools", "Shared");
    const header = b64uEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "apple-k1" })));
    const payload = b64uEncode(
      new TextEncoder().encode(
        JSON.stringify({
          iss: "https://appleid.apple.com",
          aud: "tools.selah.vault",
          sub: "apple-user-001",
          email: "shared@selah.tools",
          email_verified: true,
          exp: Math.floor(h.now / 1000) + 600,
        }),
      ),
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, new TextEncoder().encode(`${header}.${payload}`)),
    );
    const idToken = `${header}.${payload}.${b64uEncode(sig)}`;

    const res = await h.fetch("/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: idToken }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { id: string } };
    expect(body.token).toMatch(TOKEN_RE);
    expect(body.user.id).toBe(existing.user.id);
  });

  test("rejects Apple sign-in when APPLE_CLIENT_ID is unset (never skips audience check)", async () => {
    const rsa = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const h = createTestEnv(); // no APPLE_CLIENT_ID
    const header = b64uEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "apple-k1" })));
    const payload = b64uEncode(
      new TextEncoder().encode(
        JSON.stringify({
          iss: "https://appleid.apple.com",
          aud: "tools.selah.vault",
          sub: "apple-user-unset",
          exp: Math.floor(h.now / 1000) + 600,
        }),
      ),
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, new TextEncoder().encode(`${header}.${payload}`)),
    );
    const res = await h.fetch("/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: `${header}.${payload}.${b64uEncode(sig)}` }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Apple sign-in is not configured" });
  });
});

describe("OAuth 2.1 + PKCE (S256)", () => {
  test("discovery, allowlist enforcement, deny, approve, form-urlencoded + JSON token exchange, single-use code, and revoke", async () => {
    const h = createTestEnv();
    const owner = await h.createUserSession("owner@selah.tools", "Personal");

    const wellKnown = await h.fetch("/.well-known/oauth-authorization-server");
    expect(wellKnown.status).toBe(200);
    expect(wellKnown.headers.get("access-control-allow-origin")).toBe("*");
    const meta = (await wellKnown.json()) as { code_challenge_methods_supported: string[]; scopes_supported: string[] };
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.scopes_supported).toContain("srs:write");

    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk_valid_verifier_123";
    const challenge = await sha256B64u(verifier);

    // Rejects unknown redirect_uri
    const evilGet = await h.fetch(
      `/oauth/authorize?client_id=evil&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=state_123456`,
    );
    expect(evilGet.status).toBe(400);

    // Accepts native proofs://oauth/callback and loopback and route.bible
    for (const [cid, uri] of [
      ["proofs-ios", "proofs://oauth/callback"],
      ["route.bible", "https://route.bible/callback"],
      ["vault-highlights-route-bible.dpshade.workers.dev", "https://vault-highlights-route-bible.dpshade.workers.dev/cb"],
      ["proofs", "https://proofs.dpshade.workers.dev/cb"],
      ["proofs", "https://proofs.selah.tools/oauth/callback"],
      ["claude-local", "http://127.0.0.1:54321/callback"],
    ]) {
      const okGet = await h.fetch(
        `/connect?client_id=${encodeURIComponent(cid)}&redirect_uri=${encodeURIComponent(uri)}&response_type=code&scope=${encodeURIComponent("read passages:write srs:write")}&code_challenge=${challenge}&code_challenge_method=S256&state=state_123456`,
      );
      expect(okGet.status).toBe(200);
    }

    // Deny flow
    const denyRes = await h.fetch("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({
        client_id: "proofs-ios",
        redirect_uri: "proofs://oauth/callback",
        scope: "read srs:write",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "state_123456",
        approve: false,
      }),
    });
    expect(await denyRes.json()).toEqual({ redirect_to: "proofs://oauth/callback?error=access_denied&state=state_123456" });

    // Approve flow + x-www-form-urlencoded token exchange
    const appRes = await h.fetch("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({
        client_id: "proofs-ios",
        redirect_uri: "proofs://oauth/callback",
        scope: "srs:write read passages:write",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "state_abc.99",
        approve: true,
      }),
    });
    expect(appRes.status).toBe(200);
    const redirectUrl = new URL(((await appRes.json()) as { redirect_to: string }).redirect_to);
    expect(redirectUrl.searchParams.get("state")).toBe("state_abc.99");
    const code = redirectUrl.searchParams.get("code")!;

    const tokRes = await h.fetch("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "proofs://oauth/callback",
        client_id: "proofs-ios",
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokRes.status).toBe(200);
    expect(tokRes.headers.get("access-control-allow-origin")).toBe("*");
    const tok = (await tokRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
      user: { id: string; name: string };
    };
    expect(tok.access_token).toMatch(TOKEN_RE);
    expect(tok.token_type).toBe("Bearer");
    expect(tok.expires_in).toBe(7_776_000);
    expect(tok.scope).toBe("passages:write read srs:write");
    expect(tok.user).toEqual({ id: owner.user.id, name: "Personal" });

    // Single-use code replay fails
    const replayTok = await h.fetch("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: "proofs://oauth/callback",
        client_id: "proofs-ios",
        code_verifier: verifier,
      }),
    });
    expect(replayTok.status).toBe(400);

    // OAuth token works on /v2/bootstrap, then revokes via POST /oauth/revoke
    expect((await h.fetch("/v2/bootstrap", { headers: { authorization: `Bearer ${tok.access_token}` } })).status).toBe(200);
    const rev = await h.fetch("/oauth/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    expect(rev.status).toBe(200);
    expect((await h.fetch("/v2/bootstrap", { headers: { authorization: `Bearer ${tok.access_token}` } })).status).toBe(401);
  });
});

async function registerPasskeySession(h: ReturnType<typeof createTestEnv>, name = "Key Vault") {
  const optRes = await h.fetch("/auth/passkey/register/options", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const opts = (await optRes.json()) as { challenge: string };
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const credIdBytes = crypto.getRandomValues(new Uint8Array(20));
  const credId = b64uEncode(credIdBytes);
  const coseKey = new Map<unknown, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, b64uDecode(jwk.x!)],
    [-3, b64uDecode(jwk.y!)],
  ]);
  const coseBytes = cborEncode(coseKey);
  const rpHash = await sha256Bytes("vault.selah.tools");
  const authData = new Uint8Array(55 + credIdBytes.length + coseBytes.length);
  authData.set(rpHash, 0);
  authData[32] = 0x45;
  authData[36] = 1;
  authData[53] = 0;
  authData[54] = credIdBytes.length;
  authData.set(credIdBytes, 55);
  authData.set(coseBytes, 55 + credIdBytes.length);
  const attObj = cborEncode(new Map<unknown, unknown>([["fmt", "none"], ["authData", authData]]));
  const clientDataReg = b64uEncode(
    new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin: TEST_ORIGIN })),
  );
  const regRes = await h.fetch("/auth/passkey/register/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      credential: {
        id: credId,
        type: "public-key",
        response: { clientDataJSON: clientDataReg, attestationObject: b64uEncode(attObj), transports: ["internal"] },
      },
    }),
  });
  const body = (await regRes.json()) as { token: string; user: { id: string; email: string | null; name: string } };
  const cookie = regRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { status: regRes.status, token: body.token, user: body.user, cookie, credId };
}

async function mintAppleToken(
  rsa: CryptoKeyPair,
  claims: Record<string, unknown>,
  kid = "apple-k1",
) {
  const header = b64uEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid })));
  const payload = b64uEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, new TextEncoder().encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${b64uEncode(sig)}`;
}

describe("Linking sign-in methods to one account", () => {
  test("GET /config.json reports whether Apple and email delivery are configured", async () => {
    const off = createTestEnv({ sendEmail: undefined, RESEND_API_KEY: undefined, APPLE_CLIENT_ID: undefined });
    const offCfg = (await (await off.fetch("/config.json")).json()) as {
      appleClientId: string | null;
      emailConfigured: boolean;
    };
    expect(offCfg.appleClientId).toBeNull();
    expect(offCfg.emailConfigured).toBe(false);

    const on = createTestEnv({ APPLE_CLIENT_ID: "tools.selah.vault" });
    const onCfg = (await (await on.fetch("/config.json")).json()) as {
      appleClientId: string | null;
      emailConfigured: boolean;
    };
    expect(onCfg.appleClientId).toBe("tools.selah.vault");
    expect(onCfg.emailConfigured).toBe(true);
  });

  test("unauthenticated GET /auth/methods is 401", async () => {
    const h = createTestEnv();
    expect((await h.fetch("/auth/methods")).status).toBe(401);
  });

  test("verifying email while signed in links it to the same user and does not create another", async () => {
    const h = createTestEnv();
    const passkey = await registerPasskeySession(h, "Passkey Only");
    expect(passkey.status).toBe(200);
    expect(passkey.user.email).toBeNull();

    const send = await h.fetch("/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "linked@selah.tools" }),
    });
    expect(send.status).toBe(200);
    const verify = await h.fetch("/auth/email/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${passkey.token}`,
        origin: TEST_ORIGIN,
      },
      body: JSON.stringify({ email: "linked@selah.tools", code: h.emails[0]!.code }),
    });
    expect(verify.status).toBe(200);
    const body = (await verify.json()) as { user: { id: string; email: string } };
    expect(body.user.id).toBe(passkey.user.id);
    expect(body.user.email).toBe("linked@selah.tools");

    const methods = await h.fetch("/auth/methods", { headers: { authorization: `Bearer ${passkey.token}` } });
    expect(methods.status).toBe(200);
    const listed = (await methods.json()) as { email: string; passkeys: Array<{ id: string; suffix: string }> };
    expect(listed.email).toBe("linked@selah.tools");
    expect(listed.passkeys).toHaveLength(1);
    expect(listed.passkeys[0]!.id).toBe(passkey.credId);
    expect(listed.passkeys[0]!.suffix).toBeTruthy();

    const users = h.authDb.query("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(users.n).toBe(1);
  });

  test("linking an email already owned by another account returns 409 and leaves both users alone", async () => {
    const h = createTestEnv();
    const owner = await h.createUserSession("taken@selah.tools", "Owner");
    const other = await registerPasskeySession(h, "Other");

    await h.fetch("/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "taken@selah.tools" }),
    });
    const res = await h.fetch("/auth/email/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${other.token}`,
      },
      body: JSON.stringify({ email: "taken@selah.tools", code: h.emails[h.emails.length - 1]!.code }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already linked to another account" });

    const methods = (await (await h.fetch("/auth/methods", { headers: { authorization: `Bearer ${other.token}` } })).json()) as {
      email: string | null;
    };
    expect(methods.email).toBeNull();
    const ownerMe = await h.fetch("/auth/me", { headers: { authorization: `Bearer ${owner.token}` } });
    expect(((await ownerMe.json()) as { user: { email: string; id: string } }).user).toEqual({
      id: owner.user.id,
      email: "taken@selah.tools",
      name: "Owner",
    });
    expect((h.authDb.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(2);
  });

  test("cookie-authenticated email verify without a matching Origin is rejected with 403 before linking", async () => {
    const h = createTestEnv();
    const passkey = await registerPasskeySession(h, "CSRF");
    await h.fetch("/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "csrf-link@selah.tools" }),
    });
    const res = await h.fetch("/auth/email/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: passkey.cookie,
      },
      body: JSON.stringify({ email: "csrf-link@selah.tools", code: h.emails[0]!.code }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf origin mismatch" });
  });

  test("Apple sign-in while signed in attaches apple_sub to the session user", async () => {
    const rsa = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const pubJwk = await crypto.subtle.exportKey("jwk", rsa.publicKey);
    const h = createTestEnv({
      APPLE_CLIENT_ID: "tools.selah.vault",
      fetchJwks: (async () =>
        new Response(JSON.stringify({ keys: [{ ...pubJwk, kid: "apple-k1", alg: "RS256", use: "sig" }] }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const passkey = await registerPasskeySession(h, "Apple Link");
    const idToken = await mintAppleToken(rsa, {
      iss: "https://appleid.apple.com",
      aud: "tools.selah.vault",
      sub: "apple-user-link",
      email: "relay@privaterelay.appleid.com",
      email_verified: true,
      exp: Math.floor(h.now / 1000) + 600,
    });
    const res = await h.fetch("/auth/apple", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${passkey.token}`,
      },
      body: JSON.stringify({ id_token: idToken }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string } };
    expect(body.user.id).toBe(passkey.user.id);
    expect(body.user.email).toBe("relay@privaterelay.appleid.com");
    const methods = (await (await h.fetch("/auth/methods", { headers: { authorization: `Bearer ${passkey.token}` } })).json()) as {
      apple: boolean;
      appleConfigured: boolean;
      email: string;
    };
    expect(methods.apple).toBe(true);
    expect(methods.appleConfigured).toBe(true);
    expect(methods.email).toBe("relay@privaterelay.appleid.com");
    expect(JSON.stringify(methods)).not.toContain("apple-user-link");
    expect((h.authDb.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(1);
  });

  test("listing methods includes passkeys and refuses to remove the last remaining method", async () => {
    const h = createTestEnv();
    const owner = await h.createUserSession("solo@selah.tools", "Solo");
    const listed = await h.fetch("/auth/methods", { headers: { authorization: `Bearer ${owner.token}` } });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { email: string; apple: boolean; passkeys: unknown[] };
    expect(body.email).toBe("solo@selah.tools");
    expect(body.apple).toBe(false);
    expect(body.passkeys).toEqual([]);

    const removed = await h.fetch("/auth/methods/remove", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ type: "email" }),
    });
    expect(removed.status).toBe(400);
    expect(await removed.json()).toEqual({ error: "cannot remove the last sign-in method" });
    expect(
      ((await (await h.fetch("/auth/methods", { headers: { authorization: `Bearer ${owner.token}` } })).json()) as { email: string })
        .email,
    ).toBe("solo@selah.tools");
  });

  test("removing a passkey only deletes one owned by the current user", async () => {
    const h = createTestEnv();
    const a = await registerPasskeySession(h, "Alice");
    const b = await registerPasskeySession(h, "Bob");

    // Give Alice a second method so removing her own passkey would be allowed.
    await h.fetch("/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@selah.tools" }),
    });
    expect(
      (
        await h.fetch("/auth/email/verify", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
          body: JSON.stringify({ email: "alice@selah.tools", code: h.emails[0]!.code }),
        })
      ).status,
    ).toBe(200);

    const steal = await h.fetch("/auth/methods/remove", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ type: "passkey", id: b.credId }),
    });
    expect(steal.status).toBe(404);
    expect(h.authDb.query("SELECT user_id FROM passkeys WHERE credential_id = ?").get(b.credId) as { user_id: string }).toEqual({
      user_id: b.user.id,
    });

    const own = await h.fetch("/auth/methods/remove", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ type: "passkey", id: a.credId }),
    });
    expect(own.status).toBe(200);
    const after = (await own.json()) as { passkeys: unknown[]; email: string };
    expect(after.passkeys).toEqual([]);
    expect(after.email).toBe("alice@selah.tools");
    expect(h.authDb.query("SELECT COUNT(*) AS n FROM passkeys WHERE credential_id = ?").get(a.credId) as { n: number }).toEqual({
      n: 0,
    });
  });
});
