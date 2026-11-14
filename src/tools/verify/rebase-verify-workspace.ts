import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** Rebase explicit project references into the workspace that actually executes a guarded check. */
export function rebaseVerifyWorkspaceValue<T>(value: T, from: string, to: string, platform: NodeJS.Platform = process.platform, home = homedir()): T {
  const fold = (text: string): string => platform === "win32" || platform === "darwin" ? text.toLowerCase() : text;
  if (typeof value === "string") {
    const boundary = (next: string | undefined): boolean => next === undefined || /[\/\\\s"'`);,:}\]]/.test(next);
    const before = (previous: string | undefined): boolean => previous === undefined || /[\s"'`(=;,{\[]/.test(previous);
    let text: string = value;
    for (const spelling of [...new Set([from, from.replace(/\\/g, "/")])]) {
      let rest: string = text, rewritten = "";
      const next = (): number => fold(rest).indexOf(fold(spelling));
      for (let index = next(); index >= 0; index = next()) {
        const end = index + spelling.length;
        if (!before(rest[index - 1]) || !boundary(rest[end])) {
          rewritten += rest.slice(0, end); rest = rest.slice(end); continue;
        }
        rewritten += rest.slice(0, index) + to; rest = rest.slice(end);
      }
      text = rewritten + rest;
    }
    // This is a restricted literal-path remapper, not a shell parser. Refuse
    // recognizable home/escaped/normalized aliases rather than certify a
    // check that still names its source. External paths and siblings stay put.
    const paths = platform === "win32" ? win32 : posix;
    const identity = (path: string): string => {
      const resolved = paths.resolve(path).replace(/\\/g, "/");
      return fold(platform === "darwin" ? resolved.normalize("NFC") : resolved);
    };
    const root = identity(from);
    const tokens = [...text.matchAll(/[^\s"'`()=;,\[\]]+/g)].map(match => match[0]);
    tokens.push(...[...text.matchAll(/["'`]([^"'`]+)["'`]/g)].map(match => match[1]!));
    for (let token of tokens) {
      token = token.replace(/^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=[\/\\]|$)/i, home);
      if (!paths.isAbsolute(token)) continue;
      const normalized = identity(token);
      if (normalized === root || normalized.startsWith(`${root}/`)) throw new Error("verification check plan has an unsupported absolute project reference");
    }
    return text as T;
  }
  if (Array.isArray(value)) return value.map(item => rebaseVerifyWorkspaceValue(item, from, to, platform, home)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebaseVerifyWorkspaceValue(item, from, to, platform, home)])) as T;
  return value;
}
