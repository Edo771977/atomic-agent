import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** A real compiler launcher without the file-symlink privilege Windows lacks. */
export function installTestTypeScriptCompiler(project: string): string {
  const compiler = resolve("node_modules/typescript/bin/tsc");
  const windows = process.platform === "win32";
  const launcher = join(project, "node_modules", ".bin", windows ? "tsc.cmd" : "tsc");
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, windows
    ? `@"${process.execPath}" "${compiler}" %*\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(compiler)});\n`);
  if (!windows) chmodSync(launcher, 0o755);
  return launcher;
}
