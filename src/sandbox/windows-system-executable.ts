import { win32 } from "node:path";

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/** Unlike win32.isAbsolute, this excludes drive-rooted `\\tools\\cmd.exe`. */
function fullyQualified(path: string | undefined): path is string {
  if (path === undefined || /[\x00-\x1f"<>|*]/.test(path)) return false;
  const normal = win32.normalize(path);
  if (normal.startsWith("\\\\.\\")) return false;
  const plain = normal.startsWith("\\\\?\\") ? normal.slice(4) : normal;
  if (plain.includes("?")) return false;
  if (/^[A-Za-z]:\\/.test(plain)) return true;
  if (normal.startsWith("\\\\?\\")) return /^UNC\\[^\\]+\\[^\\]+(?:\\|$)/i.test(plain);
  return /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(plain);
}

/** Use host OS paths only: never inherit a root from a command's env override. */
export function windowsSystemExecutable(
  name: "cmd.exe" | "taskkill.exe",
  hostEnv: NodeJS.ProcessEnv = process.env,
): string {
  const systemRoot = envValue(hostEnv, "SystemRoot");
  const windir = envValue(hostEnv, "windir");
  const root = fullyQualified(systemRoot) ? systemRoot : fullyQualified(windir) ? windir : "C:\\Windows";
  return win32.join(root, "System32", name);
}

/** An explicit qualified ComSpec remains configurable; relative values cannot select cwd/PATH. */
export function windowsCommandInterpreter(
  commandEnv: NodeJS.ProcessEnv,
  hostEnv: NodeJS.ProcessEnv = process.env,
): string {
  const configured = envValue(commandEnv, "ComSpec");
  return fullyQualified(configured) ? configured : windowsSystemExecutable("cmd.exe", hostEnv);
}
