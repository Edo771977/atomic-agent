import { getConfig } from "../config/index.js";
import {
  outcomeLogPath,
  parseReportArgs,
  renderOutcomeReport,
} from "../tools/fusion/index.js";

const HELP =
  [
    "atomic-agent fusion — what the fusion run mode did and cost",
    "",
    "Subcommands:",
    "  report [--days N] [--model X] [--json]",
    "      Per worker model: tasks, first-pass green rate, green after",
    "      retries, top failure categories, escalation and self-check fix",
    "      rates, median time and tokens; tasks sent to the orchestrator's",
    "      model; the orchestrator's requests, prompt-cache hit rate and",
    "      spend per provider. Read from <stateDir>/fusion/outcomes.ndjson",
    "      (off with llm.runMode.fusion.outcomeLog: false).",
    "",
    "Examples:",
    "  atomic-agent fusion report --days 7",
    "  atomic-agent fusion report --model local --json",
  ].join("\n") + "\n";

export interface FusionCommandIo {
  stateDir?: () => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => Date;
}

/** `atomic-agent fusion …`: 0 done, 1 the report could not be read, 2 usage. */
export async function fusionCommand(args: string[], io: FusionCommandIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => void process.stderr.write(text));
  const sub = args[0];
  if (sub === undefined || sub === "-h" || sub === "--help") {
    stdout(HELP);
    return 0;
  }
  if (sub !== "report") {
    stderr(`unknown subcommand: ${sub}\n${HELP}`);
    return 2;
  }
  const parsed = parseReportArgs(args.slice(1));
  if (typeof parsed === "string") {
    stderr(`fusion report: ${parsed}\n`);
    return 2;
  }
  try {
    const stateDir = io.stateDir?.() ?? getConfig().paths.stateDir;
    stdout(
      renderOutcomeReport(outcomeLogPath(stateDir), {
        ...parsed,
        ...(io.now === undefined ? {} : { now: io.now() }),
      }),
    );
    return 0;
  } catch (err) {
    stderr(`fusion report failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
