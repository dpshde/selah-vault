# Authenticate with passkeys, email, Apple, and OAuth PKCE

Date: 2026-11-10

## Status

Accepted

## Context

People sign in to Selah Vault across iOS Safari, macOS, Windows, Linux, iCloud Keychain, 1Password, and Google Password Manager, and connect companion apps (`route.bible`, `Proofs` Web, `Proofs` iOS, and MCP tools) to their library. Custom secret-key ceremonies create user friction and permanent lockout risk, while WebAuthn extensions such as `prf` exclude browsers and authenticators that only implement standard discoverable credentials. Connected apps also need least-privilege, revocable access without ever seeing first-party credentials.

## Decision

Use standard first-party authentication (`src/auth.ts`) paired with OAuth 2.1 Authorization Code + PKCE (`S256`):

1. **WebAuthn ES256 passkeys (`/auth/passkey/*`):** Standard discoverable P-256 (`COSE` alg `-7`) credentials verified via WebCrypto, with no custom WebAuthn extensions.
2. **6-digit Email OTP (`/auth/email/send`, `/auth/email/verify`):** Short-lived SHA-256-hashed 6-digit codes with attempt caps, delivered via Resend (`RESEND_API_KEY`).
3. **Sign in with Apple (`POST /auth/apple`):** RS256 OIDC `id_token` verification against `https://appleid.apple.com/auth/keys` and `APPLE_CLIENT_ID`.
4. **OAuth 2.1 + PKCE `S256` (`/oauth/authorize`, `/connect`, `/oauth/token`, `/oauth/revoke`):** Allowlisted web origins (`route.bible`, `proofs.selah.tools`), `proofs://oauth/callback`, and loopback origins exchange single-use 5-minute codes plus `code_verifier` for 90-day `sv2` tokens carrying explicit scopes (`read`, `passages:write`, `highlights:write`, `notes:write`, `srs:write`) enforced per `event.kind` inside `LibraryDO`.

## Consequences

- Sign-in works out of the box across every modern browser and password manager, with email OTP and Apple Sign-In as recovery and cross-ecosystem paths.
- Connected apps never handle user credentials, cannot erase libraries or manage other apps' grants, and can be revoked individually from `/v2/grants` or `/oauth/revoke`.
