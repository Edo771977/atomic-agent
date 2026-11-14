import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const events = `${process.env.LAUNCHER_RESULT}.events.jsonl`;
const record = (event) => fs.appendFileSync(events, `${JSON.stringify({ event })}\n`);
// Isolate the legacy handler's direct models-stop subprocess too. This fixture
// must never start or stop a real daemon, even when checking the old behavior.
const exists = fs.existsSync;
fs.existsSync = (path) => /dist[\\/]cli[\\/]index\.js$/.test(String(path)) || exists(path);
childProcess.spawnSync = () => {
  record("legacy-inline-stop");
  return { status: 0, stdout: "", stderr: "" };
};
syncBuiltinESMExports();
const { installSignalHandlers, runVitest } = await import("../scripts/_lib.mjs");
const cancellation = installSignalHandlers(() => {});
const running = runVitest({ entryPath: process.env.LAUNCHER_ENTRY,
  cwd: process.env.LAUNCHER_CWD, signal: cancellation?.signal,
  ...(process.env.LAUNCHER_KILL_TIMEOUT_MS ? { killTimeoutMs: Number(process.env.LAUNCHER_KILL_TIMEOUT_MS) } : {}) });
const deadline = Date.now() + 3000;
while (!exists(process.env.LAUNCHER_RESULT) && Date.now() < deadline) await delay(10);
record("child-ready");
// Node dispatches the same installed handlers on both operating systems;
// no interactive Windows console or actual Ctrl-C injection is required.
process.emit(process.env.LAUNCHER_SIGNAL ?? "SIGINT");
if (process.env.LAUNCHER_SECOND_SIGNAL) process.emit(process.env.LAUNCHER_SECOND_SIGNAL);
let code;
try {
  code = await running;
  record("after-child-close");
} finally {
  await delay(20); // Exercise asynchronous caller-owned daemon teardown.
  record("teardown-finished");
  cancellation?.dispose();
}
record("returning");
process.exitCode = code;
