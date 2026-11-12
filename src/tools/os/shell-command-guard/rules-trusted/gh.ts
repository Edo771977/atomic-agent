import type { Rule } from "../guard-types.js";

/**
 * Read-only `gh` subcommand verbs. These never mutate remote or local
 * state (output-only), so they bypass the approval gate. Anything not
 * matched here falls through to the default approval gate.
 */
const GH_READ_VERBS: ReadonlySet<string> = new Set([
  "list",
  "view",
  "status",
  "diff",
  "checks",
  "browse",
  "search",
]);

/**
 * Verbs that mutate remote or local state. Their presence anywhere in the
 * positional token stream forces the approval gate even when a read verb is
 * also present (defence in depth — e.g. a write subcommand combined with a
 * `--json view` style flag value).
 */
const GH_WRITE_VERBS: ReadonlySet<string> = new Set([
  "create",
  "merge",
  "close",
  "delete",
  "edit",
  "add",
  "remove",
  "rename",
  "clone",
  "checkout",
  "sync",
  "fork",
  "comment",
  "review",
  "ready",
  "reopen",
  "lock",
  "unlock",
  "pin",
  "unpin",
  "transfer",
  "archive",
  "unarchive",
  "set",
  "set-default",
  "download",
  "upload",
  "cancel",
  "rerun",
  "disable",
  "enable",
  "login",
  "logout",
  "refresh",
  "token",
  "setup-git",
  "develop",
  "restore",
  "import",
  "update",
]);

/**
 * `gh api` long flags that carry a request body. Their presence makes the
 * call a POST by default, so a request using any of them, bare or joined
 * to its value (`--field=a=b`), is never auto-approved. The shorthands
 * `-f` / `-F` are read in `readShortApiFlags`.
 */
const GH_API_FIELD_LONG_FLAGS: readonly string[] = [
  "--field",
  "--raw-field",
  "--input",
];

/** `gh api` shorthands that carry a request body. */
const GH_API_FIELD_SHORT_FLAGS: ReadonlySet<string> = new Set(["f", "F"]);

/** The only boolean `gh api` shorthand (`-i`, `--include`). */
const GH_API_BOOL_SHORT_FLAGS: ReadonlySet<string> = new Set(["i"]);

const METHOD_PREFIX = "--method=";
const SHOW_TOKEN_FLAG = "--show-token";

export const ghReadOnlyRule: Rule = {
  id: "gh.read_only",
  layer: "trusted",
  match(input) {
    if (input.cmd !== "gh") return null;
    const positionals = readPositionals(input.args);
    if (positionals.length === 0) return null;

    if (positionals[0] === "api") {
      if (!isReadOnlyGhApi(input.args)) return null;
      return {
        action: "allow",
        rule: "gh.api_read",
        reason: "gh api read-only request",
      };
    }

    if (positionals[0] === "auth" && showsToken(input.args)) return null;
    if (positionals.some((word) => GH_WRITE_VERBS.has(word))) return null;
    const reads = positionals.filter((word) => GH_READ_VERBS.has(word));
    if (reads.length === 0) return null;
    return {
      action: "allow",
      rule: "gh.read_only",
      reason: `gh read-only command (${reads.join(",")})`,
    };
  },
};

function readPositionals(args: readonly string[]): string[] {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    words.push(arg.toLowerCase());
  }
  return words;
}

function isReadOnlyGhApi(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (GH_API_FIELD_LONG_FLAGS.some((flag) => isLongFlag(arg, flag))) {
      return false;
    }
    if (arg === "--method") {
      if (!isReadMethod(args[i + 1] ?? "")) return false;
      i += 1;
      continue;
    }
    if (arg.startsWith(METHOD_PREFIX)) {
      if (!isReadMethod(arg.slice(METHOD_PREFIX.length))) return false;
      continue;
    }
    if (isShortFlagCluster(arg)) {
      const read = readShortApiFlags(arg, args[i + 1]);
      if (read === "write") return false;
      if (read === "consumed-next") i += 1;
    }
  }
  return true;
}

/**
 * Read one shorthand cluster the way gh's flag parser does: boolean
 * shorthands may lead (`-i`), and the first value-taking shorthand takes
 * the rest of the word, or the next argument, as its value. So `-XDELETE`
 * and `-iXPOST` set the method, and `-fbody=x` / `-Fa=b` carry a body.
 */
function readShortApiFlags(
  arg: string,
  next: string | undefined,
): "read" | "write" | "consumed-next" {
  for (let j = 1; j < arg.length; j += 1) {
    const flag = arg[j]!;
    if (GH_API_BOOL_SHORT_FLAGS.has(flag)) continue;
    if (GH_API_FIELD_SHORT_FLAGS.has(flag)) return "write";
    if (flag !== "X") return "read";
    const inline = arg.slice(j + 1);
    if (inline.length > 0) return isReadMethod(inline) ? "read" : "write";
    return isReadMethod(next ?? "") ? "consumed-next" : "write";
  }
  return "read";
}

/**
 * `gh auth status --show-token` (`-t`) prints the stored token, so it is
 * not a read the guard may run unasked. Any shorthand cluster holding a
 * `t` counts, erring towards asking.
 */
function showsToken(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      isLongFlag(arg, SHOW_TOKEN_FLAG) ||
      (isShortFlagCluster(arg) && arg.includes("t")),
  );
}

function isLongFlag(arg: string, flag: string): boolean {
  return arg === flag || arg.startsWith(`${flag}=`);
}

function isShortFlagCluster(arg: string): boolean {
  return arg.length > 1 && arg.startsWith("-") && !arg.startsWith("--");
}

function isReadMethod(value: string): boolean {
  const method = value.toUpperCase();
  return method === "GET" || method === "HEAD";
}
