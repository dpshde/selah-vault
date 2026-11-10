// Sign-in code email for Selah Vault. HTML is table-based and inline-styled so
// it holds up in Gmail, Apple Mail, and Outlook. The icon is a PNG because
// many clients still drop SVG.

export const EMAIL_OTP_TTL_MS = 10 * 60_000;
export const EMAIL_OTP_TTL_MINUTES = EMAIL_OTP_TTL_MS / 60_000;

/** Opaque 180px "ii" apple-touch icon, already live on v1. Displayed at 64px. */
export const EMAIL_ICON_URL = "https://vault.selah.tools/apple-touch-icon.r2.png";

const CODE_RE = /^\d{6}$/;

const FONT =
  "Lexend, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO =
  "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export interface SignInCodeEmail {
  subject: string;
  text: string;
  html: string;
}

/** Build the subject, plain-text, and HTML bodies for a 6-digit sign-in code. */
export function signInCodeEmail(code: string): SignInCodeEmail {
  if (!CODE_RE.test(code)) {
    throw new Error("sign-in code must be 6 digits");
  }
  const minutes = String(EMAIL_OTP_TTL_MINUTES);
  const subject = `${code} is your Selah Vault code`;
  const text = [
    "Selah Vault",
    "",
    `Your sign-in code is ${code}.`,
    "",
    `It expires in ${minutes} minutes.`,
    "",
    "If you didn't ask for this code, you can ignore this email.",
  ].join("\n");

  // Light-mode colors from public/style.css (--bg, --surface, --raised, --fg,
  // --muted, --line). Dark-mode overrides live in the <style> block. Lexend is
  // Vault's face; the @font-face URLs point at the live v1 files so clients
  // that honor them match the app, and Helvetica Neue (Vault's own fallback)
  // covers the rest.
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${subject}</title>
  <style>
    :root { color-scheme: light dark; }
    @font-face {
      font-family: Lexend;
      font-style: normal;
      font-weight: 100 900;
      font-display: swap;
      src: url("https://vault.selah.tools/fonts/lexend/lexend-latin-ext.woff2") format("woff2");
      unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
    }
    @font-face {
      font-family: Lexend;
      font-style: normal;
      font-weight: 100 900;
      font-display: swap;
      src: url("https://vault.selah.tools/fonts/lexend/lexend-latin.woff2") format("woff2");
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
    }
    @media (prefers-color-scheme: dark) {
      .page { background-color: #000 !important; }
      .card { background-color: #08090c !important; border-color: #1c1f26 !important; }
      .ink { color: #f1f3f7 !important; }
      .muted { color: #a1a7b2 !important; }
      .codebox { background-color: #0e0f12 !important; border-color: #1c1f26 !important; }
      .rule { border-top-color: #1c1f26 !important; }
    }
  </style>
</head>
<body class="page" style="margin:0;padding:0;background-color:#f3f0eb;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f3f0eb;">
    Expires in ${minutes} minutes.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="page" style="background-color:#f3f0eb;margin:0;padding:0;width:100%;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" class="card" style="width:100%;max-width:480px;background-color:#faf9f6;border:1px solid #d8cfbf;">
          <tr>
            <td align="center" style="padding:40px 32px 32px;">
              <img src="${EMAIL_ICON_URL}" width="64" height="64" alt="Selah Vault" style="display:block;width:64px;height:64px;border:0;outline:none;text-decoration:none;">
              <h1 class="ink" style="margin:16px 0 0;font-family:${FONT};font-size:22px;line-height:1.2;font-weight:700;letter-spacing:-0.03em;color:#241f19;">Selah Vault</h1>
              <p class="muted" style="margin:8px 0 0;font-family:${FONT};font-size:15px;line-height:1.4;font-weight:400;color:#6a6156;">Your sign-in code</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="codebox" style="width:100%;background-color:#ebe8e3;border:1px solid #e8dfd1;">
                <tr>
                  <td align="center" style="padding:20px 16px;">
                    <span class="ink" style="font-family:${MONO};font-size:32px;line-height:1.2;font-weight:600;letter-spacing:0.28em;margin-right:-0.28em;color:#241f19;">${code}</span>
                  </td>
                </tr>
              </table>
              <p class="muted" style="margin:14px 0 0;font-family:${FONT};font-size:13px;line-height:1.4;color:#6a6156;text-align:center;">Expires in ${minutes} minutes.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="rule" style="border-top:1px solid #e8dfd1;font-size:0;line-height:0;height:1px;">&nbsp;</td>
                </tr>
              </table>
              <p class="muted" style="margin:16px 0 0;font-family:${FONT};font-size:12px;line-height:1.5;color:#6a6156;text-align:center;">If you didn't ask for this code, you can ignore this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
