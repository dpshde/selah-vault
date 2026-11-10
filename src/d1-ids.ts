// Shared D1 identity constants for selah-vault-auth.
// The real database id is filled in after provisioning; until then the placeholder
// (and the forbidden live v1 prod id) must fail hygiene so we never bind the wrong DB.

/** D1 database name / binding target for `mise run db:migrate:prod`. */
export const SELAH_VAULT_AUTH_D1_NAME = "selah-vault-auth";

/**
 * Placeholder id until the dedicated `selah-vault-auth` D1 is provisioned.
 * Never deploy or migrate production against this value.
 */
export const SELAH_VAULT_AUTH_D1_ID_PLACEHOLDER = "00000000-0000-4000-a000-000000000000";

/**
 * Live v1 Worker production D1 id. Must never appear as the v2 `DB` binding.
 * Legacy retirement must delete this id only — never `selah-vault-auth`.
 */
export const FORBIDDEN_V1_PROD_D1_ID = "4e60d989-d13b-4884-ad5c-1366f4c73f00";

/**
 * Current configured id (placeholder until replaced with the real provisioned uuid).
 * When replacing, update this value AND the matching literal in `cloudflare.config.ts`.
 */
export const SELAH_VAULT_AUTH_D1_ID = SELAH_VAULT_AUTH_D1_ID_PLACEHOLDER;
