import { posix, win32 } from "node:path";

/**
 * One Win32 path component as NTFS opens it: trailing dots and spaces are
 * dropped, and a `:stream` suffix (the default `::$DATA` or a named
 * alternate stream, which writes into the same file) names the same file.
 * A component of only dots/spaces keeps its spelling.
 */
export function windowsComponentIdentity(component: string): string {
  const colon = component.indexOf(":");
  const name = (colon === -1 ? component : component.slice(0, colon)).replace(/[. ]+$/, "");
  return name.length === 0 ? component : name;
}

/**
 * Lexical identity for resolved input paths; display spelling and link
 * targets stay untouched. macOS folds case and Unicode normalization as
 * its default case-insensitive APFS volumes open names; on a
 * case-sensitive APFS volume this over-protects (two distinct files that
 * differ only in case are treated as one), which is the safe direction.
 */
export function inputPathIdentity(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return posix.resolve(path).normalize("NFC").toLowerCase();
  if (platform !== "win32") return posix.resolve(path);
  const normalized = win32.resolve(path);
  const { root } = win32.parse(normalized);
  const components = normalized.slice(root.length).split("\\").filter(part => part.length > 0).map(windowsComponentIdentity);
  return (root + components.join("\\")).toLowerCase();
}
