import { writeFileSync } from "node:fs";

writeFileSync(process.env.LAUNCHER_RESULT, JSON.stringify({
  args: process.argv.slice(2), execPath: process.execPath, pid: process.pid,
  extra: process.env.LAUNCHER_EXTRA,
}));
if (process.env.LAUNCHER_MODE === "cancel") setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.LAUNCHER_EXIT ?? "0");
