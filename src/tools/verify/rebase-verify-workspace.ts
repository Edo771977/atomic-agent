/** Rebase explicit project references into the workspace that actually executes a guarded check. */
export function rebaseVerifyWorkspaceValue<T>(value: T, from: string, to: string, platform: NodeJS.Platform = process.platform): T {
  const fold = (text: string): string => platform === "win32" || platform === "darwin" ? text.toLowerCase() : text;
  if (typeof value === "string") {
    const boundary = (next: string | undefined): boolean => next === undefined || /[\/\\\s"'`);,:}\]]/.test(next);
    let text: string = value;
    for (const spelling of [...new Set([from, from.replace(/\\/g, "/")])]) {
      let rest: string = text, rewritten = "";
      const next = (): number => fold(rest).indexOf(fold(spelling));
      for (let index = next(); index >= 0; index = next()) {
        const end = index + spelling.length;
        if (!boundary(rest[end])) {
          rewritten += rest.slice(0, end); rest = rest.slice(end); continue;
        }
        rewritten += rest.slice(0, index) + to; rest = rest.slice(end);
      }
      text = rewritten + rest;
    }
    // Escaped command-language paths are not safely understood by a generic
    // rewriter. Refuse a remaining project reference instead of executing it
    // against the source rather than the guarded copy.
    const normalized = fold(text.replace(/\\+/g, "/")), root = fold(from.replace(/\\+/g, "/"));
    for (let at = normalized.indexOf(root); at >= 0; at = normalized.indexOf(root, at + root.length)) {
      const after = normalized[at + root.length];
      if (boundary(after)) throw new Error("verification check plan has an unsupported absolute project reference");
    }
    return text as T;
  }
  if (Array.isArray(value)) return value.map(item => rebaseVerifyWorkspaceValue(item, from, to, platform)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebaseVerifyWorkspaceValue(item, from, to, platform)])) as T;
  return value;
}
