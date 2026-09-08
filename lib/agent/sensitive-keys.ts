const SENSITIVE_KEY_NAMES = new Set([
  "apikey",
  "accesskey",
  "accesskeyid",
  "secretkey",
  "secretaccesskey",
  "authorization",
  "credential",
  "credentials",
  "password",
  "passwd",
  "clientsecret",
  "oauthclientsecret",
  "privatekey",
  "privatekeypem",
  "sessiontoken",
  "awssessiontoken",
  "token",
]);

/** Collapses camelCase, kebab-case, snake_case, dotted, and spaced key variants. */
export function normalizeSensitiveKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/** One classifier shared by contract, runtime-publication, redaction, and persistence boundaries. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(normalizeSensitiveKey(key));
}
