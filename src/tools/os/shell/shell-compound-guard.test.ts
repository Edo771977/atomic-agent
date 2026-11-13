import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate, type ApprovalRequest } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

// A subshell line is judged on its first word by the safe-allow and
// trusted rules. A second command chained after it (newline, `;`, `&&`,
// a pipe, a substitution) must not ride on that verdict and run unasked.
describe.skipIf(process.platform === "win32")(
  "os.shell.run compound lines are never auto-allowed",
  () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "atomic-shell-compound-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    function decliningTool(asked: ApprovalRequest[]) {
      const gate = new ApprovalGate({
        level: 1,
        emit: (req) => {
          asked.push(req);
          gate.resolve({ approvalId: req.approvalId, approved: false });
        },
      });
      return buildOsShellTool({ approvals: gate, approvalRequired: true });
    }

    function ctx(): ToolContext {
      return {
        workingDir: dir,
        sessionId: "test-session",
        stepIndex: 0,
        signal: new AbortController().signal,
      } as ToolContext;
    }

    async function pwnedExists(): Promise<boolean> {
      try {
        await stat(join(dir, "pwned.txt"));
        return true;
      } catch {
        return false;
      }
    }

    it.each([
      "echo hi\ntouch pwned.txt",
      "echo hi\rtouch pwned.txt",
      "gh pr list ; touch pwned.txt",
      "gh pr list && touch pwned.txt",
      "gh pr list | touch pwned.txt",
      "gh pr view $(touch pwned.txt)",
      "icalBuddy eventsToday ; touch pwned.txt",
      "pwd\ntouch pwned.txt",
      // Single-quoted text is literal, but not behind a comment.
      "gh pr list # '\ntouch pwned.txt\n'",
      "gh pr view 'x'y;touch pwned.txt",
    ])("asks before running %j", async (cmd) => {
      const asked: ApprovalRequest[] = [];
      try {
        await decliningTool(asked).run({ cmd }, ctx());
      } catch {
        // a declined approval surfaces as an error; that is the point
      }
      expect(asked.length).toBe(1);
      expect(await pwnedExists()).toBe(false);
    });

    it("still runs a single safe command unasked", async () => {
      const asked: ApprovalRequest[] = [];
      const result = await decliningTool(asked).run({ cmd: "echo hi there" }, ctx());
      expect(asked.length).toBe(0);
      expect(result.status).toBe("ok");
    });
  },
);
