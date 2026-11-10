// Standard WebAuthn P-256 passkey + Email OTP + Sign in with Apple client helpers for Selah Vault v2.
// No WebAuthn PRF extension or sync keys: passkeys authenticate standard ES256 assertions against /auth/passkey/*.

export const passkeysAvailable = () =>
  typeof PublicKeyCredential !== "undefined" && typeof navigator !== "undefined" && !!navigator.credentials;

export const cancelled = (error) => error?.name === "NotAllowedError" || error?.name === "AbortError";

export function toBase64Url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  const s = String(text ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function postJson(url, body = {}, fetchFn = globalThis.fetch.bind(globalThis)) {
  const res = await fetchFn(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function decodeCreationOptions(raw) {
  const opts = raw.publicKey ?? raw;
  return {
    challengeId: raw.challengeId ?? opts.challengeId,
    publicKey: {
      ...opts,
      challenge: fromBase64Url(opts.challenge),
      user: { ...opts.user, id: fromBase64Url(opts.user.id) },
      excludeCredentials: (opts.excludeCredentials ?? []).map((c) => ({ ...c, id: fromBase64Url(c.id) })),
    },
  };
}

function decodeRequestOptions(raw) {
  const opts = raw.publicKey ?? raw;
  return {
    challengeId: raw.challengeId ?? opts.challengeId,
    publicKey: {
      ...opts,
      challenge: fromBase64Url(opts.challenge),
      allowCredentials: (opts.allowCredentials ?? []).map((c) => ({ ...c, id: fromBase64Url(c.id) })),
    },
  };
}

export async function registerPasskey({ name = "Personal", fetch: fetchFn } = {}) {
  const raw = await postJson("/auth/passkey/register/options", { name }, fetchFn);
  const { challengeId, publicKey } = decodeCreationOptions(raw);
  const cred = await navigator.credentials.create({ publicKey });
  if (!cred) throw new Error("Passkey creation was cancelled.");
  const resp = cred.response;
  return postJson("/auth/passkey/register/verify", {
    challengeId,
    name,
    id: cred.id,
    rawId: toBase64Url(cred.rawId),
    type: cred.type,
    credential: {
      id: cred.id,
      rawId: toBase64Url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: toBase64Url(resp.clientDataJSON),
        attestationObject: toBase64Url(resp.attestationObject),
        transports: resp.getTransports?.() ?? [],
      },
    },
    response: {
      clientDataJSON: toBase64Url(resp.clientDataJSON),
      attestationObject: toBase64Url(resp.attestationObject),
      transports: resp.getTransports?.() ?? [],
    },
  }, fetchFn);
}

export async function loginWithPasskey({ fetch: fetchFn } = {}) {
  const raw = await postJson("/auth/passkey/login/options", {}, fetchFn);
  const { challengeId, publicKey } = decodeRequestOptions(raw);
  const cred = await navigator.credentials.get({ publicKey });
  if (!cred) throw new Error("Passkey sign-in was cancelled.");
  const resp = cred.response;
  return postJson("/auth/passkey/login/verify", {
    challengeId,
    id: cred.id,
    rawId: toBase64Url(cred.rawId),
    type: cred.type,
    credential: {
      id: cred.id,
      rawId: toBase64Url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: toBase64Url(resp.clientDataJSON),
        authenticatorData: toBase64Url(resp.authenticatorData),
        signature: toBase64Url(resp.signature),
        userHandle: resp.userHandle ? toBase64Url(resp.userHandle) : null,
      },
    },
    response: {
      clientDataJSON: toBase64Url(resp.clientDataJSON),
      authenticatorData: toBase64Url(resp.authenticatorData),
      signature: toBase64Url(resp.signature),
      userHandle: resp.userHandle ? toBase64Url(resp.userHandle) : null,
    },
  }, fetchFn);
}

export async function sendEmailCode(email, { fetch: fetchFn } = {}) {
  return postJson("/auth/email/send", { email: String(email ?? "").trim() }, fetchFn);
}

export async function verifyEmailCode(email, code, { name, fetch: fetchFn } = {}) {
  return postJson("/auth/email/verify", {
    email: String(email ?? "").trim(),
    code: String(code ?? "").trim(),
    ...(name ? { name } : {}),
  }, fetchFn);
}

export async function signInWithApple(idToken, { name, fetch: fetchFn } = {}) {
  return postJson("/auth/apple", { id_token: idToken, idToken, ...(name ? { name } : {}) }, fetchFn);
}

export async function fetchSession({ fetch: fetchFn = globalThis.fetch.bind(globalThis) } = {}) {
  const res = await fetchFn("/auth/me", { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.user ?? (data?.authenticated ? data : null);
}

export async function signOutSession({ fetch: fetchFn = globalThis.fetch.bind(globalThis) } = {}) {
  await fetchFn("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
}

export async function fetchSignInMethods({ fetch: fetchFn = globalThis.fetch.bind(globalThis) } = {}) {
  const res = await fetchFn("/auth/methods", { credentials: "same-origin", cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export async function removeSignInMethod(body, { fetch: fetchFn } = {}) {
  return postJson("/auth/methods/remove", body, fetchFn);
}

export async function renamePasskey({ credentialId, name }, { fetch: fetchFn } = {}) {
  return postJson("/auth/methods/rename", { credentialId, name }, fetchFn);
}

