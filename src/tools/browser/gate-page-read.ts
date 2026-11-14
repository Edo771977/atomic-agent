import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { invalidLocalFileUrlReason, localFileOfUrl } from "../read-scope/read-scope-targets.js";
import {
  blockedHostOfPage,
  webHostOf,
  type BrowserDomainPolicy,
  type LocalPageReader,
} from "./browser-domain-policy.js";
import { requireUserSite, userSiteCleared } from "./user-profile-sites.js";

export type PageReadVerdict =
  | { kind: "ok" }
  | { kind: "blocked"; host: string }
  | { kind: "user_site_not_cleared"; host: string | null }
  | { kind: "local_file_refused"; path: string; why: string };

/** Ask for an uncleared site in the user's own Chrome instead of refusing it. */
export interface PageReadAsk {
  dangerous: DangerousToolOptions;
  tool: string;
  signal: AbortSignal;
}

/**
 * Who reads a page, for the local-file check (`policy.localPages`).
 * `allowUrl` is the URL the calling tool itself asked for: its file was
 * checked (and asked about) at dispatch, like any read tool's target, so
 * landing on it is not refused a second time.
 */
export interface LocalPageRead {
  reader: LocalPageReader;
  allowUrl?: string;
}

/**
 * The first local file among a page and its frames that the read scope
 * would not let through unasked, or `null`. A redirect (meta refresh, a
 * script) or a click on a `file://` listing reaches a file the requested
 * URL never named, so the landed page is checked like a read.
 */
export function localPageRefusal(
  urls: readonly string[],
  policy: BrowserDomainPolicy,
  local: LocalPageRead | undefined,
): { path: string; why: string } | null {
  // Validate before allowUrl: an unchecked URL must never exempt itself,
  // even in an embedder without a session read-scope policy.
  for (const url of urls) {
    const invalid = invalidLocalFileUrlReason(url);
    if (invalid !== null) return { path: url, why: invalid };
  }
  const check = policy.localPages;
  if (check === undefined || local === undefined) return null;
  const allowed =
    local.allowUrl === undefined ? null : localFileOfUrl(local.allowUrl);
  for (const url of urls) {
    const path = localFileOfUrl(url);
    if (path === null || path === allowed) continue;
    const why = check(url, local.reader);
    if (why !== null) return { path, why };
  }
  return null;
}

/** The refusal text for a page on a local file the read scope does not cover. */
export function localPageMessage(tool: string, path: string, why: string): string {
  return `${tool}: the page is the local file ${path}, which ${why}, so it is not read. Open it with browser.navigate so the user is asked, or read it with os.fs.read.`;
}

/**
 * The one check before page content reaches the model: every snapshot
 * view (`read_aria`, the world snapshot after navigate / search) and
 * every screenshot goes through it.
 *
 * - The page, or any frame it embeds, on a blocked host: `blocked`.
 * - The page, or a frame, on a local file outside the read scope or one
 *   of the agent's own secret files (`policy.localPages`, with `local`):
 *   `local_file_refused`. Refused, not asked: the question belongs to
 *   the navigation that opens the file.
 * - The user's own Chrome (`policy.userProfile`): a site not cleared
 *   this session asks once with `ask` (`user-profile-sites.ts`; a "no"
 *   throws `ApprovalDeniedError`); without `ask`, or without a session,
 *   it is `user_site_not_cleared`.
 */
export async function gatePageRead(
  page: { url: string; frameUrls?: readonly string[] },
  policy: BrowserDomainPolicy,
  sessionId: string | undefined,
  ask?: PageReadAsk,
  local?: LocalPageRead,
): Promise<PageReadVerdict> {
  const blocked = blockedHostOfPage(page.url, page.frameUrls, policy);
  if (blocked !== null) return { kind: "blocked", host: blocked };
  const localFile = localPageRefusal(
    [page.url, ...(page.frameUrls ?? [])],
    policy,
    local,
  );
  if (localFile !== null) return { kind: "local_file_refused", ...localFile };
  if (!policy.userProfile) return { kind: "ok" };
  const host = webHostOf(page.url);
  if (sessionId !== undefined && userSiteCleared(policy, host, sessionId)) return { kind: "ok" };
  if (ask && sessionId !== undefined) {
    await requireUserSite(ask.dangerous, policy, ask.tool, host, `read ${page.url}`, {
      sessionId,
      signal: ask.signal,
    });
    return { kind: "ok" };
  }
  return { kind: "user_site_not_cleared", host };
}
