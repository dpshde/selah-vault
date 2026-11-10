-- Optional display name for a passkey (user-renameable; defaulted from the User-Agent on create).
-- Additive: existing rows keep name NULL and fall back to "Passkey · <suffix>" in the UI.
ALTER TABLE passkeys ADD COLUMN name TEXT;
