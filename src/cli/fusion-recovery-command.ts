import { recoverPromotion, type RecoveryResult } from "../tools/fusion/promotion-recovery.js";

export async function fusionRecoveryCommand(args: string[], io: { stdout(text: string): void; stderr(text: string): void }): Promise<number> {
  let project: string | undefined, journal: string | undefined, mode: RecoveryResult["mode"] = "status", selected = false, json = false;
  try {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "--project") {
        if (project !== undefined || args[index + 1] === undefined || args[index + 1]!.startsWith("--")) throw new Error("--project requires one directory");
        project = args[++index];
      } else if (arg === "--json") json = true;
      else if (["--status", "--dry-run", "--rollback"].includes(arg)) {
        if (selected) throw new Error("choose only one recovery mode"); selected = true;
        mode = arg === "--dry-run" ? "dry-run" : arg === "--rollback" ? "rollback" : "status";
      } else if (arg.startsWith("-") || journal !== undefined) throw new Error(`unexpected argument: ${arg}`);
      else journal = arg;
    }
    if (project === undefined || journal === undefined) throw new Error("recover <journal> --project <dir> [--status|--dry-run|--rollback] [--json]");
  } catch (error) { io.stderr(`fusion recover: ${(error as Error).message}\n`); return 2; }
  try {
    const result = await recoverPromotion({ project: project!, journal: journal!, mode });
    io.stdout(json ? `${JSON.stringify(result)}\n` : `Fusion recovery: ${result.state} (${mode}); ${result.planned.length} planned, ${result.restored.length} restored, ${result.conflicts.length} conflicts, ${result.retainedStaging.length} staging files retained${result.ownerAlive ? "; owner still alive" : ""}\n${result.conflicts.map(path => `  preserved: ${path}\n`).join("")}${result.retainedStaging.map(path => `  retained staging: ${path}\n`).join("")}`);
    return result.conflicts.length === 0 ? 0 : 1;
  } catch (error) { io.stderr(`fusion recover failed: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
