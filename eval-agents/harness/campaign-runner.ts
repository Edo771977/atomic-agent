import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VitestTestRunner } from "vitest/runners";
import { updateTask, type File } from "@vitest/runner";

/** Campaign completion is outside test hooks: title-filtered suites skip hooks. */
export default class GaiaCampaignRunner extends VitestTestRunner {
  override onAfterRunFiles(files: File[] = []): void {
    super.onAfterRunFiles();
    try {
      const dir = process.env.ATOMIC_AGENT_GAIA_REPORT_DIR;
      if (!dir) throw new Error("GAIA campaign completion report is missing");
      const campaign = JSON.parse(readFileSync(resolve(dir, "campaign.json"), "utf8")) as { executed?: number };
      if (!(typeof campaign.executed === "number" && campaign.executed > 0)) {
        throw new Error("no GAIA agent cases executed; all selected cases were skipped or filtered out");
      }
    } catch (error) {
      // Mark the file failed and let Vitest flush its normal task/report
      // updates. Throwing here would discard already-buffered test failures.
      const file = files[0];
      if (!file) throw error;
      file.result = { ...file.result, state: "fail", errors: [...(file.result?.errors ?? []),
        { name: "CampaignCompletionError", message: error instanceof Error ? error.message : String(error) }] };
      updateTask(file, this);
    }
  }
}
