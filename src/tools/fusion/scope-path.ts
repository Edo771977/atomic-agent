import { resolve } from "node:path";

const DEVICE_PREFIX = /^[\\/]{2}[?.](?:[\\/]|$)/;
const RESERVED_COMPONENT = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

function unsupportedComponent(part: string): boolean {
  return part === "." || part === ".." || /[. ]$/.test(part) ||
    /[<>:"|?*\u0000-\u001f]/.test(part) || RESERVED_COMPONENT.test(part);
}

/**
 * A spelling comparable with ordinary native scope paths, or no safe
 * comparison. Extended drive/UNC paths identify the same files only when
 * removing their prefix does not invoke Win32's different normalization
 * of dot segments, trailing dots/spaces or reserved device components.
 * Device namespaces and other extended forms are refused, not guessed.
 * This is lexical scope handling; it does not resolve symbolic links.
 */
export function comparableScopePath(path: string): string | null {
  if (process.platform !== "win32") return path;
  if (!DEVICE_PREFIX.test(path)) {
    // Ordinary Win32 trailing-dot/space aliases also cannot safely serve
    // as an independent grant beside the canonical home/project path.
    const parts = resolve(path).replace(/^[A-Za-z]:\\/, "").split("\\").filter(Boolean);
    return parts.some(unsupportedComponent) ? null : path;
  }
  if (!path.startsWith("\\\\?\\") || path.includes("/")) return null;
  const tail = path.slice(4);
  let ordinary: string;
  let parts: string[];
  if (/^[A-Za-z]:\\/.test(tail)) {
    ordinary = tail;
    parts = tail.slice(3).split("\\");
  } else if (/^UNC\\/i.test(tail)) {
    parts = tail.slice(4).split("\\");
    if (!parts[0] || !parts[1]) return null;
    ordinary = `\\\\${tail.slice(4)}`;
  } else {
    return null;
  }
  if (parts.some((part, i) => part === "" ? i !== parts.length - 1 : unsupportedComponent(part))) return null;
  return ordinary;
}
