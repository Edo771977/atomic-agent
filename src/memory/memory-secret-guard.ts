/**
 * Durable memory never holds a credential: profile facts are rendered into
 * every prompt (cloud included), and notes, lessons and procedures are
 * recalled into them. Every store's write path asks these questions
 * and refuses the write with its own validation error, never echoing the
 * value. Detection is the shared credential detector
 * (`src/error-reporting/secret-detector.ts`) plus the agent's own `.env`
 * values, so an already-masked `[redacted:…]` marker is accepted, plus
 * the labelled phrases below. Those live here rather than in the shared
 * detector: "the password is X" is worth refusing in a durable fact, but
 * masking every such phrase in tool output and error reports would cut
 * too much ordinary text.
 */

import {
  isSecretHoldingName,
  knownSecretsFromEnv,
  maskSecrets,
} from "../error-reporting/secret-detector.js";

/**
 * A credential label, then `:` / `=` / "is" / "was", then one token:
 * "password: correcthorsebatterystaple", "wifi password is hunter2",
 * "API key: 0123…", "aws secret access key = …". Group 1 is the label,
 * group 2 the value. Linear: alternations of literals, one bounded run.
 */
const LABELLED_VALUE =
  /\b(passwords?|passwd|passphrase|passcode|pass ?word|pwd|pw|pin(?: code)?|api[ _-]?key|secret(?:[ _-]access)?(?:[ _-]key)?|access[ _-]key|private[ _-]key|auth[ _-]token|access[ _-]token|bearer token|token)\b[ \t]*(?::|=|\bis\b|\bwas\b|\bequals\b)[ \t]*["'`]?([^\s"'`,;]{3,256})/gi;

/** Words that follow "password is" / "token:" in prose about a credential, not a value. */
const NOT_A_VALUE = new Set(
  (
    "a an the my your his her their our its this that not never no none null nil " +
    "true false yes on off ok fine also still now there here same different " +
    "set unset reset changed change changes update updated rotated expired expires " +
    "stored saved kept managed shared sent written encrypted hashed generated random " +
    "provided given required optional needed missing empty blank hidden unknown " +
    "incorrect wrong correct invalid valid weak strong secure insecure long short " +
    "protected manager managers policy field hint prompt length complexity login " +
    "enabled disabled redacted placeholder in at from with without for of to by " +
    "being only too very less free case-sensitive available configured"
  ).split(" "),
);

const PASSWORD_LABEL = /^(?:passwords?|passwd|passphrase|passcode|pass ?word|pwd|pw)$/i;
const PIN_LABEL = /^pin(?: code)?$/i;

/** Whether a labelled value is plausibly the credential itself. */
function isLabelledCredential(label: string, rawValue: string): boolean {
  const value = rawValue.replace(/[.!?)\]]+$/, "");
  if (value.length < 3) return false;
  if (NOT_A_VALUE.has(value.toLowerCase())) return false;
  if (value.includes("[redacted:")) return false;
  // References, placeholders, paths and URLs: where it is, not what it is.
  if (/^(?:\$|%|\{\{|<|\/|~\/|\.{1,2}\/|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(value)) return false;
  if (/^(.)\1+$/.test(value)) return false; // ******** / xxxxxxxx
  if (PIN_LABEL.test(label)) return /^\d{4,8}$/.test(value);
  if (PASSWORD_LABEL.test(label)) {
    // "hunter2", "Tr0ub4dor&3", "correcthorsebatterystaple": a digit, a
    // symbol, an inner capital or a long run. A short plain word is prose
    // ("the password was rejected", "password: see vault").
    return (
      value.length >= 4 &&
      (/[^A-Za-z]/.test(value) || /.[A-Z]/.test(value) || value.length >= 12)
    );
  }
  // Key / token / secret labels name many things ("token: 4096", "secret:
  // sauce"); only a long unbroken run counts, hex or not.
  return (
    value.length >= 16 &&
    /^[A-Za-z0-9_+/=.-]+$/.test(value) &&
    /\d/.test(value) &&
    /[A-Za-z]/.test(value)
  );
}

function hasLabelledCredential(text: string): boolean {
  for (const match of text.matchAll(LABELLED_VALUE)) {
    if (isLabelledCredential(match[1]!, match[2]!)) return true;
  }
  return false;
}

/** Whether `text` contains a credential: a detector shape, a known value or a labelled one. */
export function containsSecret(text: string): boolean {
  if (maskSecrets(text, knownSecretsFromEnv()) !== text) return true;
  return hasLabelledCredential(text);
}

/**
 * Whether a profile key names a credential (`openai_api_key`,
 * `github_token`, `wifi password`). Spaces count as separators.
 */
export function isSecretKey(key: string): boolean {
  return isSecretHoldingName(key.trim().replace(/\s+/g, "_"));
}

/**
 * Whether a key and its value together carry a credential the two do not
 * carry apart: `pin` = `4821`, `router_pw` = `hunter2`, `api.key` = a
 * hex run. Checked as `key: value` with the key's separators read as
 * spaces, so a label inside it is seen by the labelled-phrase check. Not
 * as a raw `key=value` through the shared detector: its secret-name rule
 * would take `password_manager=1Password` for a password, and a key that
 * holds a credential by name is refused on its own (`isSecretKey`).
 */
export function containsSecretPair(key: string, value: string): boolean {
  const spaced = key.trim().replace(/[_.-]+/g, " ");
  return containsSecret(`${spaced}: ${value}`);
}

/** The refusal text shared by every store; it never contains the value. */
export const SECRET_REFUSAL =
  "looks like a credential (API key, token or password); secrets are never stored in memory";
