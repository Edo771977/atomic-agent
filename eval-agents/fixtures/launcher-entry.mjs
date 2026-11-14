import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const mode = process.env.LAUNCHER_MODE;
// "tree"/"stubborn" model a Vitest worker that started an agent process:
// the grandchild shares the entry's process group and outlives it unless
// the launcher terminates the whole tree. "stubborn" ignores SIGTERM too;
// "leak" exits normally while its grandchild keeps running.
let grandchildPid;
if (mode === "tree" || mode === "stubborn" || mode === "leak") {
  const ignore = mode === "stubborn" ? "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});" : "";
  const grandchild = spawn(process.execPath, ["-e", `${ignore}setInterval(()=>{},1000)`], { stdio: "ignore" });
  grandchildPid = grandchild.pid;
  if (mode === "leak") grandchild.unref(); // entry exits normally, leaving it behind
  if (mode === "stubborn") { process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); }
}
writeFileSync(process.env.LAUNCHER_RESULT, JSON.stringify({
  args: process.argv.slice(2), execPath: process.execPath, pid: process.pid,
  grandchildPid,
  extra: process.env.LAUNCHER_EXTRA,
  reportDir: process.env.ATOMIC_AGENT_GAIA_REPORT_DIR,
}));
if (mode === "campaign") {
  const dir = resolve(process.env.ATOMIC_AGENT_GAIA_REPORT_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "campaign.json"), JSON.stringify({ selected: 1, executed: 1 }));
}
if (mode === "cancel" || mode === "tree" || mode === "stubborn") setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.LAUNCHER_EXIT ?? "0");
