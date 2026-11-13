import type {
  GuardInput,
  GuardVerdict,
  Rule,
  ShellGuardPolicy,
} from "./guard-types.js";
import { normaliseCommand } from "./normalise.js";
import { hardlineRule } from "./rules-hardline.js";
import { buildGitRemotePolicyRule } from "./rules-policy.js";
import { dangerousRule } from "./rules-dangerous.js";
import { gogReadOnlyRule } from "./rules-trusted/gog.js";
import { ghReadOnlyRule } from "./rules-trusted/gh.js";
import { icalBuddyReadOnlyRule } from "./rules-trusted/ical-buddy.js";
import { safeAllowRule } from "./rules-safe-allow.js";

/** Everything after the hardline layer, in evaluation order. */
const RULES_AFTER_HARDLINE: readonly Rule[] = [
  dangerousRule,
  gogReadOnlyRule,
  ghReadOnlyRule,
  icalBuddyReadOnlyRule,
  safeAllowRule,
];

const DEFAULT_RULES: readonly Rule[] = [hardlineRule, ...RULES_AFTER_HARDLINE];

/**
 * Evaluate the default rule set. A `policy` (injected by the bootstrap,
 * absent in unit tests and embedders that have no config) adds the
 * operator-policy layer right after the hardline rules, so a policy
 * refusal can never be shadowed by a trusted or safe-allow match.
 */
export function checkShellCommandGuard(
  input: GuardInput,
  policy?: ShellGuardPolicy,
): GuardVerdict {
  const rules = policy
    ? [hardlineRule, buildGitRemotePolicyRule(policy), ...RULES_AFTER_HARDLINE]
    : DEFAULT_RULES;
  return checkShellCommandGuardWithRules(input, rules);
}

export function checkShellCommandGuardWithRules(
  input: GuardInput,
  rules: readonly Rule[],
): GuardVerdict {
  const normalised = normaliseSafely(input);
  if (normalised.status === "error") return normalised.verdict;

  for (const rule of rules) {
    try {
      const verdict = rule.match(normalised.command, input);
      if (verdict !== null) return confineAllowToSingleCommand(verdict, rule, input);
    } catch {
      return {
        action: "approval_required",
        rule: `${rule.id}.error`,
        reason: `rule ${rule.id} threw (fail-closed)`,
      };
    }
  }

  return {
    action: "approval_required",
    rule: "default",
    reason: "no shell guard rule matched; approval required",
  };
}

/**
 * Shell syntax that ends one command and starts another, or runs one
 * inside another: newlines, `;`, `&`, `|`, backticks, `$(`, process
 * substitution and grouping, plus redirects (a write the rule never
 * judged). Double-quoted occurrences count too (a double quote still
 * expands `$(` and backticks); only POSIX single-quoted text is skipped
 * (`withoutSingleQuoted`).
 */
const COMPOUND_SHELL_SYNTAX = /[\n\r;&|`<>()]/;

/**
 * `line` with every POSIX single-quoted span removed, for the compound
 * check. Inside `'…'` a POSIX shell reads every character literally (no
 * escapes, no expansions), so `--jq '.[] | .t'` is one argument, not a
 * pipe. Conservative wherever the reading is not certain: the whole line
 * is returned unchanged when it holds ANSI-C quoting (`$'…'`, which has
 * escapes), a `#` (a comment), a `${` or a quote that never closes. A backslash outside quotes
 * escapes the next character (`\'` opens nothing); double-quoted text is
 * kept as is, and a `'` inside it is a plain character.
 */
export function withoutSingleQuoted(line: string): string {
  // Where a quote stops being a quote: ANSI-C `$'…'` has escapes, a
  // `#` comment hides a `'` from the shell but not from this scan, and
  // `${…}` nests quoting inside double quotes. Read such a line whole.
  if (line.includes("$'") || line.includes("${") || line.includes("#")) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "\\") {
      out += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      if (close === -1) return line;
      // Keep the span a word boundary of its own: `a'x'b` stays one word.
      out += "''";
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
      if (j >= line.length) return line;
      out += line.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The safe-allow and trusted rules judge one command by its first word.
 * On a subshell line that also chains, pipes or substitutes another
 * command, their allow would cover commands they never read, so it
 * becomes an approval instead. Refusals and approvals pass through.
 */
function confineAllowToSingleCommand(
  verdict: GuardVerdict,
  rule: Rule,
  input: GuardInput,
): GuardVerdict {
  if (verdict.action !== "allow") return verdict;
  if (rule.layer !== "safe-allow" && rule.layer !== "trusted") return verdict;
  if (input.shellLine === undefined) return verdict;
  const line =
    input.shellQuoting === "posix" ? withoutSingleQuoted(input.shellLine) : input.shellLine;
  if (!COMPOUND_SHELL_SYNTAX.test(line)) return verdict;
  return {
    action: "approval_required",
    rule: "guard.compound_line",
    reason: `${verdict.rule} covers one command; the line chains or substitutes others`,
  };
}

function normaliseSafely(
  input: GuardInput,
):
  | { status: "ok"; command: ReturnType<typeof normaliseCommand> }
  | { status: "error"; verdict: GuardVerdict } {
  try {
    return { status: "ok", command: normaliseCommand(input) };
  } catch {
    return {
      status: "error",
      verdict: {
        action: "approval_required",
        rule: "guard.normalise_failed",
        reason: "shell guard normalisation failed (fail-closed)",
      },
    };
  }
}
