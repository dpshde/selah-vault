-- Global identity directory for Selah Vault v2 (users, WebAuthn passkeys, OTP/WebAuthn challenges, OAuth 2.1 codes).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  apple_sub TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT 'Personal',
  created_at INTEGER NOT NULL
);

CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX passkeys_user_idx ON passkeys (user_id);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT,
  secret_hash TEXT NOT NULL,
  user_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX auth_challenges_target_idx ON auth_challenges (kind, target);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX oauth_codes_user_idx ON oauth_codes (user_id);
