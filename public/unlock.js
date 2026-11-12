// /unlock: clean Selah Vault v2 sign-in (Passkey, Email 6-digit OTP, Sign in with Apple).
import {
  cancelled,
  fetchSession,
  loginWithPasskey,
  passkeysAvailable,
  registerPasskey,
  sendEmailCode,
  signInWithApple,
  verifyEmailCode,
} from "./passkey.js";
import { setupThemeToggle } from "./theme-toggle.js";

const $ = (sel) => document.querySelector(sel);
setupThemeToggle(document.querySelectorAll(".theme-toggle"));

function safeNext(raw) {
  if (!raw || typeof raw !== "string") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

const params = new URLSearchParams(location.search);
const nextPath = safeNext(params.get("next"));
let pendingEmail = "";

function resetEmailSignIn() {
  $("#email-verify-form").hidden = true;
  $("#email-send-form").hidden = true;
  $("#email-login")?.setAttribute("aria-expanded", "false");
}

function showEmailSignIn() {
  $("#email-verify-form").hidden = true;
  $("#email-send-form").hidden = false;
  $("#email-login")?.setAttribute("aria-expanded", "true");
  $("#email-input")?.focus();
}

function setError(msg = "") {
  const el = $("#auth-error");
  if (el) el.textContent = msg;
}

function completeSignIn() {
  location.replace(nextPath);
}

if (!passkeysAvailable()) {
  $("#passkey-login").hidden = true;
  if ($("#passkey-register")) $("#passkey-register").hidden = true;
}

$("#email-login")?.addEventListener("click", () => {
  setError("");
  if (!$("#email-send-form").hidden) {
    resetEmailSignIn();
    return;
  }
  showEmailSignIn();
});

$("#passkey-login")?.addEventListener("click", async () => {
  setError("");
  try {
    await loginWithPasskey();
    completeSignIn();
  } catch (error) {
    if (!cancelled(error)) setError(error.message);
  }
});

$("#passkey-register")?.addEventListener("click", async () => {
  setError("");
  try {
    await registerPasskey({ name: "Personal" });
    completeSignIn();
  } catch (error) {
    if (!cancelled(error)) setError(error.message);
  }
});

$("#email-send-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("");
  const email = String(new FormData(e.target).get("email") ?? "").trim();
  if (!email) return;
  try {
    await sendEmailCode(email);
    pendingEmail = email;
    $("#email-sent-note").textContent = `Enter the 6-digit code sent to ${email}.`;
    $("#email-send-form").hidden = true;
    $("#email-verify-form").hidden = false;
    $("#otp-input")?.focus();
  } catch (error) {
    setError(error.message);
  }
});

$("#email-back")?.addEventListener("click", () => {
  setError("");
  showEmailSignIn();
});

$("#email-verify-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("");
  const code = String(new FormData(e.target).get("code") ?? "").trim();
  try {
    await verifyEmailCode(pendingEmail, code);
    completeSignIn();
  } catch (error) {
    setError(error.message);
  }
});

$("#apple-login")?.addEventListener("click", async () => {
  setError("");
  try {
    if (globalThis.AppleID?.auth) {
      const resp = await globalThis.AppleID.auth.signIn();
      const idToken = resp?.authorization?.id_token;
      if (!idToken) throw new Error("Apple did not return an identity token.");
      const fullName = [resp?.user?.name?.firstName, resp?.user?.name?.lastName].filter(Boolean).join(" ").trim();
      await signInWithApple(idToken, { name: fullName || undefined });
      completeSignIn();
      return;
    }
    const res = await fetch("/config.json", { cache: "no-store" }).catch(() => null);
    const cfg = res?.ok ? await res.json().catch(() => ({})) : {};
    if (!cfg?.appleClientId) throw new Error("Sign in with Apple isn't configured on this server yet. Use a passkey or email.");
    const url = new URL("https://appleid.apple.com/auth/authorize");
    url.searchParams.set("client_id", cfg.appleClientId);
    url.searchParams.set("redirect_uri", `${location.origin}/auth/apple`);
    url.searchParams.set("response_type", "code id_token");
    url.searchParams.set("response_mode", "form_post");
    url.searchParams.set("scope", "name email");
    url.searchParams.set("state", nextPath);
    location.assign(url.href);
  } catch (error) {
    if (!cancelled(error)) setError(error.message);
  }
});

fetchSession().then((user) => {
  if (user) completeSignIn();
});
