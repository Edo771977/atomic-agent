/**
 * Durable memory never holds a credential: profile facts are rendered into
 * every prompt (cloud included), and notes, lessons and procedures are
 * recalled into them. Every store's write path asks these two questions
 * and refuses the write with its own validation error, never echoing the
 * value. Detection is the shared credential detector
 * (`src/error-reporting/secret-detector.ts`) plus the agent's own `.env`
 * values, so an already-masked `[redacted:…]` marker is accepted.
 */

import {
  isSecretHoldingName,
  knownSecretsFromEnv,
  maskSecrets,
} from "../error-reporting/secret-detector.js";

/** Whether `text` contains something the credential detector would mask. */
export function containsSecret(text: string): boolean {
  return maskSecrets(text, knownSecretsFromEnv()) !== text;
}

/** Whether a profile key names a credential (`openai_api_key`, `github_token`). */
export function isSecretKey(key: string): boolean {
  return isSecretHoldingName(key);
}

/** The refusal text shared by every store; it never contains the value. */
export const SECRET_REFUSAL =
  "looks like a credential (API key, token or password); secrets are never stored in memory";
