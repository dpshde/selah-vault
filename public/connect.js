// OAuth 2.1 + PKCE consent screen (/connect and /oauth/authorize).
import {
  cancelled,
  fetchSession,
  loginWithPasskey,
  passkeysAvailable,
  registerPasskey,
  sendEmailCode,
  signInWithApple,
  signOutSession,
  verifyEmailCode,
} from "./passkey.js";
import { allowedClient, clientInfo, consentLines, parseScopes } from "./grants.js";
import { appleErrorMessage, applePopupSignIn, idTokenFromAppleResponse, preloadAppleSdk } from "./apple-auth.js";

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const clientId = (params.get("client_id") ?? "").trim();
const redirectUri = (params.get("redirect_uri") ?? "").trim();
const responseType = params.get("response_type") ?? "";
const codeChallenge = params.get("code_challenge") ?? "";
const codeChallengeMethod = params.get("code_challenge_method") ?? "";
const state = params.get("state") ?? "";
const scopes = parseScopes(params.get("scope") || "read");
const clientOrigin = clientId && redirectUri ? allowedClient(redirectUri, clientId) : null;

const validPkce = /^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) && codeChallengeMethod === "S256";
const validState = /^[A-Za-z0-9_.-]{8,128}$/.test(state);
const validRequest = Boolean(clientOrigin && responseType === "code" && scopes && validPkce && validState);

const ICONS = {
  eye: '<path d="M247.31,124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57,61.26,162.88,48,128,48S61.43,61.26,36.34,86.35C17.51,105.18,9,124,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208s66.57-13.26,91.66-38.34c18.83-18.83,27.3-37.61,27.65-38.4A8,8,0,0,0,247.31,124.76ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.47,133.47,0,0,1,25,128,133.33,133.33,0,0,1,48.07,97.25C70.33,75.19,97.22,64,128,64s57.67,11.19,79.93,33.25A133.46,133.46,0,0,1,231.05,128C223.84,141.46,192.43,192,128,192Zm0-112a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z"/>',
  bookmark: '<path d="M184,32H72A16,16,0,0,0,56,48V224a8,8,0,0,0,12.24,6.78L128,193.43l59.77,37.35A8,8,0,0,0,200,224V48A16,16,0,0,0,184,32Zm0,177.57-51.77-32.35a8,8,0,0,0-8.48,0L72,209.57V48H184Z"/>',
  note: '<path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H156.69A15.86,15.86,0,0,0,168,219.31L219.31,168A15.86,15.86,0,0,0,224,156.69V48A16,16,0,0,0,208,32ZM48,48H208V152H160a8,8,0,0,0-8,8v48H48Zm148.69,112L168,188.69V160Z"/>',
  cards: '<path d="M216,40H72A16,16,0,0,0,56,56V72H40A16,16,0,0,0,24,88V200a16,16,0,0,0,16,16H184a16,16,0,0,0,16-16V184h16a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM184,200H40V88H184Zm32-32H200V88a16,16,0,0,0-16-16H72V56H216Z"/>',
  lock: '<path d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z"/>',
  clock: '<path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z"/>',
  check: '<path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a11.32,11.32,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/>',
  x: '<path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/>',
};
const svg = (name, cls = "") => `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${ICONS[name] ?? ICONS.eye}</svg>`;

function show(id) {
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== id;
}

function step(id) {
  $("#step-signin").hidden = id !== "signin";
  $("#step-consent").hidden = id !== "consent";
}

function showConsent(user) {
  const display = user?.name || user?.email || "Personal";
  $("#account-name").textContent = display;
  $("#account-initial").textContent = (display.trim()[0] || "P").toUpperCase();
  $("#perms").replaceChildren(
    ...consentLines(scopes).map((line) => {
      const li = document.createElement("li");
      li.dataset.ok = String(line.ok);
      li.innerHTML = `${svg(line.icon)}<span></span>${svg(line.ok ? "check" : "x", "oauth-mark")}`;
      li.querySelector("span").textContent = line.text;
      return li;
    }),
  );
  $("#consent-error").textContent = "";
  step("consent");
}

let pendingEmail = "";

async function decide(approve) {
  $("#allow").disabled = true;
  $("#deny").disabled = true;
  try {
    const res = await fetch("/oauth/authorize", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scopes.join(" "),
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        approve,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.redirect_to) {
      if (!approve) {
        const fallback = new URL(redirectUri);
        fallback.searchParams.set("error", "access_denied");
        fallback.searchParams.set("state", state);
        location.replace(fallback.href);
        return;
      }
      throw new Error(data.error || `Couldn't authorize (${res.status}).`);
    }
    location.replace(data.redirect_to);
  } catch (error) {
    $("#consent-error").textContent = error.message;
    $("#allow").disabled = false;
    $("#deny").disabled = false;
  }
}

if (!validRequest) {
  show("bad");
} else {
  history.replaceState(null, "", location.pathname);
  const app = clientInfo(clientOrigin, clientId);
  document.querySelectorAll(".app-name").forEach((el) => (el.textContent = app.name));
  $("#app-origin").textContent = clientOrigin;
  if (app.icon) {
    const img = Object.assign(document.createElement("img"), { src: app.icon, alt: "", width: 48, height: 48 });
    $("#app-logo").append(img);
  } else {
    $("#app-logo").innerHTML = `<span class="oauth-letter">${app.name[0]}</span>`;
  }
  document.title = `${app.name} · Allow access · Selah Vault`;
  show("card");
  if (!passkeysAvailable()) {
    $("#passkey-login").hidden = true;
    $("#passkey-create-row").hidden = true;
    $("#email-details").open = true;
  }
  fetchSession().then((user) => {
    if (user) showConsent(user);
    else step("signin");
  });
  loadAppleConfig();
}

/** Shows Sign in with Apple only when the server has it configured, and preloads Apple's SDK so a tap opens the popup at once. */
async function loadAppleConfig() {
  const button = $("#apple-login");
  if (!button) return;
  button.hidden = true;
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    const data = res.ok ? await res.json() : {};
    if (!data.appleClientId) return;
    button.hidden = false;
    preloadAppleSdk(data.appleClientId);
  } catch {}
}

$("#switch")?.addEventListener("click", async () => {
  await signOutSession();
  step("signin");
});

$("#passkey-login")?.addEventListener("click", async () => {
  $("#signin-error").textContent = "";
  try {
    const res = await loginWithPasskey();
    showConsent(res?.user ?? (await fetchSession()));
  } catch (error) {
    if (!cancelled(error)) $("#signin-error").textContent = error.message;
  }
});

$("#passkey-register")?.addEventListener("click", async () => {
  $("#signin-error").textContent = "";
  try {
    const res = await registerPasskey({ name: "Personal" });
    showConsent(res?.user ?? (await fetchSession()));
  } catch (error) {
    if (!cancelled(error)) $("#signin-error").textContent = error.message;
  }
});

$("#email-send-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#signin-error").textContent = "";
  const email = String(new FormData(e.target).get("email") ?? "").trim();
  try {
    await sendEmailCode(email);
    pendingEmail = email;
    $("#email-send-form").hidden = true;
    $("#email-verify-form").hidden = false;
    $("#otp-input")?.focus();
  } catch (error) {
    $("#signin-error").textContent = error.message;
  }
});

$("#email-verify-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#signin-error").textContent = "";
  const code = String(new FormData(e.target).get("code") ?? "").trim();
  try {
    const res = await verifyEmailCode(pendingEmail, code);
    showConsent(res?.user ?? (await fetchSession()));
  } catch (error) {
    $("#signin-error").textContent = error.message;
  }
});

$("#apple-login")?.addEventListener("click", async () => {
  $("#signin-error").textContent = "";
  try {
    // signIn() must run in this turn of the click — no await before it (iOS Safari).
    const resp = await applePopupSignIn();
    const { idToken, name } = idTokenFromAppleResponse(resp);
    const res = await signInWithApple(idToken, { name });
    showConsent(res?.user ?? (await fetchSession()));
  } catch (error) {
    if (!cancelled(error)) $("#signin-error").textContent = appleErrorMessage(error);
  }
});

$("#allow")?.addEventListener("click", () => decide(true));
$("#deny")?.addEventListener("click", () => decide(false));

