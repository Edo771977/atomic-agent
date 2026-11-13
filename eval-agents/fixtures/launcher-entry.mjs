import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

writeFileSync(process.env.LAUNCHER_RESULT, JSON.stringify({
  args: process.argv.slice(2), execPath: process.execPath, pid: process.pid,
  extra: process.env.LAUNCHER_EXTRA,
  reportDir: process.env.ATOMIC_AGENT_GAIA_REPORT_DIR,
}));
if (process.env.LAUNCHER_MODE === "campaign") {
  const dir = resolve(process.env.ATOMIC_AGENT_GAIA_REPORT_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "campaign.json"), JSON.stringify({ selected: 1, executed: 1 }));
}
if (process.env.LAUNCHER_MODE === "cancel") setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.LAUNCHER_EXIT ?? "0");
