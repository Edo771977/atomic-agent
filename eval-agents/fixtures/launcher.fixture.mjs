import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runVitest } from "../scripts/_lib.mjs";

const controller = new AbortController();
const running = runVitest({
  entryPath: process.env.LAUNCHER_ENTRY,
  cwd: process.env.LAUNCHER_CWD,
  forwarded: JSON.parse(process.env.LAUNCHER_ARGS ?? "[]"),
  extraEnv: { LAUNCHER_EXTRA: "injected extra env" },
  signal: controller.signal,
  ...(process.env.LAUNCHER_KILL_TIMEOUT_MS ? { killTimeoutMs: Number(process.env.LAUNCHER_KILL_TIMEOUT_MS) } : {}),
  ...(process.env.LAUNCHER_REQUIRE_CAMPAIGN === "1" ? { requireCampaign: true } : {}),
});
if (["cancel", "tree", "stubborn"].includes(process.env.LAUNCHER_MODE)) {
  const deadline = Date.now() + 3000;
  while (!existsSync(process.env.LAUNCHER_RESULT) && Date.now() < deadline) await delay(10);
  controller.abort();
}
process.exitCode = await running;
