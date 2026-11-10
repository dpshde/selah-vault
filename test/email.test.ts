import { describe, expect, test } from "bun:test";
import {
  EMAIL_ICON_URL,
  EMAIL_OTP_TTL_MINUTES,
  signInCodeEmail,
} from "../src/email";
import { createTestEnv } from "./env";

describe("signInCodeEmail", () => {
  test("puts the code in the subject, html, and text, and links the selah icon", () => {
    const code = "482910";
    const mail = signInCodeEmail(code);
    expect(mail.subject).toBe(`${code} is your Selah Vault code`);
    expect(mail.text).toContain(code);
    expect(mail.text).toContain(`expires in ${EMAIL_OTP_TTL_MINUTES} minutes`);
    expect(mail.text).toContain("If you didn't ask for this code");
    expect(mail.html).toContain(code);
    expect(mail.html).toContain(EMAIL_ICON_URL);
    expect(mail.html).toContain(`Expires in ${EMAIL_OTP_TTL_MINUTES} minutes.`);
    expect(mail.html).toContain('alt="Selah Vault"');
    // The recipient address is not interpolated into the HTML (only the generated digits are).
    expect(mail.html).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  test("rejects a non-digit or wrong-length code so it cannot land in HTML", () => {
    expect(() => signInCodeEmail("48291")).toThrow(/6 digits/);
    expect(() => signInCodeEmail("4829100")).toThrow(/6 digits/);
    expect(() => signInCodeEmail("<script>")).toThrow(/6 digits/);
  });
});

describe("Email OTP payload", () => {
  test("send delivers html and text that both include the code and icon URL", async () => {
    const h = createTestEnv();
    const sendRes = await h.fetch("/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@selah.tools" }),
    });
    expect(sendRes.status).toBe(200);
    expect(h.emails).toHaveLength(1);
    const msg = h.emails[0]!;
    expect(msg.code).toMatch(/^\d{6}$/);
    expect(msg.subject).toBe(`${msg.code} is your Selah Vault code`);
    expect(msg.text).toContain(msg.code);
    expect(msg.html).toContain(msg.code);
    expect(msg.html).toContain(EMAIL_ICON_URL);
    expect(msg.html).toContain(`Expires in ${EMAIL_OTP_TTL_MINUTES} minutes.`);
  });
});
