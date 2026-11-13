/**
 * A failed model list, in words the operator can act on. Split out of
 * `providers-wizard.tsx` so the wording is testable without rendering.
 */

import { describeOtherComputerUnreachable } from "../../llm/provider/openai/network-server-address.js";
import {
  apiKeyForWizard,
  baseUrlForWizard,
  sharedKeyNotSentNote,
} from "./providers-wizard-target.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

/**
 * `http 401` on its own reads as a product failure, when it almost
 * always means the key belongs to a different service than the one
 * selected — or, when no key went out at all, that the server wants one.
 * Saying "rejected this key" then sends the operator to check a key that
 * was never sent (ATO-1066: a server on another computer no longer gets
 * the shared compat variables).
 */
export function describeModelListError(
  error: string,
  w: ProvidersWizardState,
  service: string,
): string {
  // `http <status>` leads; the provider's own sentence may follow it, and
  // a number inside that sentence is not the status.
  const status = /^http (\d{3})\b/.exec(error)?.[1];
  // ATO-1066: a server on another computer that did not answer is about
  // that computer (asleep, server stopped, bound to 127.0.0.1, firewall).
  const unreachable = describeOtherComputerUnreachable(baseUrlForWizard(w), error);
  if (unreachable) return unreachable;
  if (status === "401" || status === "403") {
    if (!apiKeyForWizard(w)?.trim()) {
      const note = sharedKeyNotSentNote(w);
      return `${service} wants a key and no key was sent${note ? `: ${note}` : ", type its key on the key screen (Esc back)"}`;
    }
    return `${service} rejected this key, check it belongs to ${service}`;
  }
  if (status === "404") {
    return `${service} has no model list at this URL`;
  }
  return `could not list models from ${service} (${error})`;
}
