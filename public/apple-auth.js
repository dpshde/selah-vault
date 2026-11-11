// Sign in with Apple (JS SDK popup). The SDK must be preloaded so click handlers can
// call AppleID.auth.signIn() synchronously in the user gesture — iOS Safari otherwise
// blocks the popup if the handler awaited the script first.

export const APPLE_SDK_SRC = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";

export function appleSdkReady() {
  return Boolean(globalThis.AppleID?.auth);
}

export function initAppleSdk(clientId, { origin } = {}) {
  if (!clientId || !globalThis.AppleID?.auth) return false;
  const base = origin ?? globalThis.location?.origin;
  if (!base) return false;
  if (!globalThis.AppleID.auth._vaultInit) {
    globalThis.AppleID.auth.init({
      clientId,
      scope: "name email",
      redirectURI: `${base}/auth/apple`,
      usePopup: true,
    });
    globalThis.AppleID.auth._vaultInit = true;
  }
  return true;
}

export async function ensureAppleSdk(clientId, { document: doc = globalThis.document, origin } = {}) {
  if (appleSdkReady()) {
    initAppleSdk(clientId, { origin });
    return true;
  }
  if (!clientId || !doc) return false;
  await new Promise((resolve, reject) => {
    const existing = doc.querySelector("script[data-apple-auth]");
    if (existing) {
      if (appleSdkReady()) {
        resolve();
        return;
      }
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error("Couldn't load Sign in with Apple.")), { once: true });
      return;
    }
    const script = doc.createElement("script");
    script.src = APPLE_SDK_SRC;
    script.dataset.appleAuth = "true";
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error("Couldn't load Sign in with Apple.")), { once: true });
    (doc.head ?? doc.documentElement ?? doc.body).append(script);
  });
  if (!appleSdkReady()) return false;
  initAppleSdk(clientId, { origin });
  return true;
}

/** Fire-and-forget preload so a later tap can call signIn() with no await first. */
export function preloadAppleSdk(clientId, opts) {
  if (!clientId) return Promise.resolve(false);
  return ensureAppleSdk(clientId, opts).catch(() => false);
}

/**
 * Start the Apple popup. Call this directly in a click handler — do not await
 * ensureAppleSdk (or anything else) before it, or iOS Safari silently blocks the popup.
 */
export function applePopupSignIn() {
  if (!globalThis.AppleID?.auth) {
    throw new Error("Sign in with Apple is still loading. Try again in a moment.");
  }
  return globalThis.AppleID.auth.signIn();
}

export function idTokenFromAppleResponse(resp) {
  const idToken = resp?.authorization?.id_token;
  if (!idToken) throw new Error("Apple did not return an identity token.");
  const fullName = [resp?.user?.name?.firstName, resp?.user?.name?.lastName].filter(Boolean).join(" ").trim();
  return { idToken, name: fullName || undefined };
}

export function appleErrorMessage(error) {
  const msg = String(error?.message ?? error ?? "").trim();
  if (/already linked to another account/i.test(msg)) {
    return "That Apple ID is already linked to another account.";
  }
  if (msg && msg !== "[object Event]" && msg !== "[object ErrorEvent]") return msg;
  return "Couldn't sign in with Apple.";
}
