import { posix, win32 } from "node:path";

/** Lexical identity for resolved input paths; display spelling and link targets stay untouched. */
export function inputPathIdentity(path: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = (platform === "win32" ? win32 : posix).resolve(path);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
