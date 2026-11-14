import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const unsupported = (): never => { throw new Error("verification check plan has an unsupported absolute project reference"); };
const pathListNames = new Set(["PATH", "PYTHONPATH", "NODE_PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"]);

/**
 * Rebase finite, explicit literals, not evaluated shell/program expressions.
 * URL spans precede filesystem tokens; quotes keep path spaces/metacharacters.
 * Recognizable source aliases and unsupported attached options fail closed.
 */
export function rebaseVerifyWorkspaceValue<T>(value: T, from: string, to: string, platform: NodeJS.Platform = process.platform, home = homedir()): T {
  const paths = platform === "win32" ? win32 : posix;
  const fold = (text: string): string => platform === "win32" || platform === "darwin" ? text.toLowerCase() : text;
  const spelling = (text: string): string => platform === "win32" ? text.replace(/\\/g, "/") : text;
  const identity = (text: string): string => {
    const absolute = spelling(paths.resolve(text));
    return fold(platform === "darwin" ? absolute.normalize("NFC") : absolute);
  };
  const root = identity(from);
  const namesSource = (text: string): boolean => {
    const absolute = identity(text);
    return absolute === root || absolute.startsWith(root.endsWith("/") ? root : `${root}/`);
  };
  const source = spelling(from).replace(/\/$/, "") || "/";
  const expandHome = (text: string): string => text.replace(/^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=[\/\\]|$)/i, home);
  const drive = (text: string): boolean => platform === "win32" && /^[a-z]:[\/\\]/i.test(text);

  // Return undefined only when this is not an absolute/home path literal.
  const native = (text: string, allowRewrite = true): string | undefined => {
    const expanded = expandHome(text);
    const unescaped = expanded.replace(/\\\//g, "/");
    if (platform !== "win32" && unescaped !== expanded && paths.isAbsolute(unescaped) && namesSource(unescaped)) unsupported();
    if (!paths.isAbsolute(expanded)) return undefined;
    if (!namesSource(expanded)) return text;
    const comparable = spelling(text);
    const prefix = fold(comparable.slice(0, source.length)) === fold(source) &&
      (comparable.length === source.length || source === "/" || comparable[source.length] === "/");
    // Do not silently reinterpret home expansions, dot segments or escaped
    // separators. They can name the source despite a different literal prefix.
    const suffix = comparable.slice(source.length);
    if (!allowRewrite || !prefix || /[\u0000-\u001f\u007f]/.test(text) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(suffix) || /\/\//.test(suffix)) unsupported();
    return to + text.slice(source.length);
  };

  const uri = (text: string): string | undefined => {
    if (drive(text)) return undefined;
    let url: URL;
    try { url = new URL(text); } catch { return undefined; }
    if (url.protocol !== "file:") return text;
    let filename: string;
    try { filename = fileURLToPath(url, { windows: platform === "win32" }); }
    catch (error) {
      if (error instanceof URIError) {
        const components: string[] = [];
        for (const component of url.pathname.split("/")) {
          try { decodeURIComponent(component); } catch { break; }
          components.push(component);
        }
        const prefix = new URL(url); prefix.pathname = components.join("/") || "/";
        let filenamePrefix: string | undefined;
        try { filenamePrefix = fileURLToPath(prefix, { windows: platform === "win32" }); } catch { /* No native source prefix. */ }
        if (filenamePrefix !== undefined && namesSource(filenamePrefix)) unsupported();
      }
      // A benign file label, malformed external URL or non-native file URL
      // must not become a filesystem substring search through its query.
      return text;
    }
    if (!namesSource(filename)) return text;
    // WHATWG can remove literal controls from a scheme/path. Do not certify
    // such an ambiguous spelling even though it identifies a source file.
    if (/[\u0000-\u001f\u007f]/.test(text)) unsupported();
    // Find the URL pathname boundary corresponding to the native root. Keep
    // the encoded suffix verbatim instead of decoding/re-encoding filenames;
    // query and fragment are URL data and never filesystem substitutions.
    let suffix: string | undefined = root === "/" ? url.pathname : undefined;
    for (let end = 1; suffix === undefined && end <= url.pathname.length; end++) {
      if (end !== url.pathname.length && url.pathname[end] !== "/") continue;
      const prefix = new URL(url); prefix.pathname = url.pathname.slice(0, end);
      let nativePrefix: string;
      try { nativePrefix = fileURLToPath(prefix, { windows: platform === "win32" }); } catch { continue; }
      if (identity(nativePrefix) === root) suffix = url.pathname.slice(end);
    }
    if (suffix === undefined) unsupported();
    const target = pathToFileURL(to, { windows: platform === "win32" });
    target.pathname = target.pathname.replace(/\/$/, "").replace(/'/g, "%27") + suffix;
    target.search = url.search; target.hash = url.hash;
    return target.href;
  };

  const literal = (text: string): string | undefined => uri(text) ?? native(text);
  const delimiter = (char: string): boolean => /[\s"'`()=;,:<>|&@+]/.test(char);
  const quote = (char: string): boolean => char === '"' || char === "'" || char === "`";
  const quoteEnd = (text: string, start: number): number => {
    for (let end = start + 1; end < text.length; end++) {
      if (text[end] !== text[start]) continue;
      let escapes = 0;
      for (let previous = end - 1; previous > start && text[previous] === "\\"; previous--) escapes++;
      if (escapes % 2 === 0) return end;
    }
    return text.length;
  };
  const pathList = (text: string): string => {
    let result = "", start = 0;
    for (let index = 0; index <= text.length; index++) {
      // A named PATH-like value is a list even when its first relative entry
      // looks like a URL scheme. URI arguments and other env values use uri().
      const char = text[index];
      if (index !== text.length && char !== ":" && char !== ";") continue;
      if (char === ":" && index === start + 1 && drive(text.slice(start))) continue;
      if (char === ":" && index === start + 4 && /^\$env:USERPROFILE(?=[\/\\]|$)/i.test(text.slice(start))) continue;
      const entry = text.slice(start, index);
      result += (native(entry) ?? entry) + (char ?? ""); start = index + 1;
    }
    return result;
  };

  const scan = (text: string, wholeLiteral: boolean): string => {
    // Whole argv/quoted path literals retain their spaces. Path lists and
    // command bodies still need token scanning; a drive's ':' is not a list.
    const wholeUri = wholeLiteral || !/[|&<>;]/.test(text) ? uri(text) : undefined;
    if (wholeUri !== undefined) return wholeUri;
    if (wholeLiteral && !/[;|<>]/.test(text) && !text.slice(drive(text) ? 2 : 0).includes(":")) {
      const whole = native(text);
      if (whole !== undefined) return whole;
    }
    let result = "";
    for (let index = 0; index < text.length;) {
      const char = text[index]!;
      const assignment = /^([a-z_][a-z\d_]*)=/i.exec(text.slice(index));
      if (assignment !== null && pathListNames.has(assignment[1]!.toUpperCase())) {
        const prefix = assignment[0], start = index + prefix.length;
        if (quote(text[start] ?? "")) {
          const end = quoteEnd(text, start), body = text.slice(start + 1, end);
          if (end === text.length) {
            if (pathList(body) !== body) unsupported();
            result += prefix + text.slice(start); break;
          }
          result += prefix + text[start] + pathList(body) + text[start]; index = end + 1;
        } else {
          let end = start;
          while (end < text.length && !/[\s;<>|&]/.test(text[end]!)) end++;
          result += prefix + pathList(text.slice(start, end)); index = end;
        }
        continue;
      }
      if (quote(char)) {
        const end = quoteEnd(text, index);
        if (end === text.length) {
          // An unterminated quote is not safe to reinterpret as a literal.
          const remainder = text.slice(index + 1);
          if (scan(remainder, false) !== remainder) unsupported();
          result += text.slice(index); break;
        }
        const body = text.slice(index + 1, end);
        result += char + (literal(body) ?? scan(body, false)) + char;
        index = end + 1; continue;
      }
      if (delimiter(char) || /[\[\]{}]/.test(char)) { result += char; index++; continue; }

      const tail = text.slice(index);
      // URI spans are recognized before '=' and ':' are treated as syntax.
      const scheme = /^[a-z][a-z\d+.-]*:/i.test(tail) && !drive(tail);
      let end = index;
      if (scheme) {
        while (end < text.length && !/[\s"'`()<>|&;]/.test(text[end]!)) end++;
        result += uri(text.slice(index, end)) ?? text.slice(index, end);
      } else {
        // A literal root may itself contain spaces/braces/brackets. Consume
        // that known prefix before looking for surrounding syntax.
        const attached = /^-[a-z]+(?=[\/\\]|[a-z]:[\/\\])/i.exec(tail)?.[0] ?? "";
        const pathStart = index + attached.length;
        const rootCandidate = spelling(text.slice(pathStart, pathStart + source.length));
        if (fold(rootCandidate) === fold(source)) end = pathStart + source.length;
        const homePrefix = /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=[\/\\]|$)/i.exec(text.slice(pathStart));
        if (homePrefix !== null) end = Math.max(end, pathStart + homePrefix[0].length);
        while (end < text.length) {
          const next = text[end]!;
          if (delimiter(next)) {
            if (next === ":" && end === pathStart + 1 && drive(text.slice(pathStart))) { end++; continue; }
            break;
          }
          end++;
        }
        if (end === index) { result += char; index++; continue; }
        const token = text.slice(index, end);
        if (attached !== "") {
          const path = token.slice(attached.length);
          const supported = attached === "-C" || attached === "-I";
          result += attached + (native(path, supported) ?? path);
        } else result += native(token) ?? token;
      }
      index = end;
    }
    return result;
  };

  const visit = (item: unknown, command = false, environment = false, list = false): unknown => {
    if (typeof item === "string") return list ? pathList(item) : scan(item, !command);
    if (Array.isArray(item)) return item.map(child => visit(child));
    if (item !== null && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, key === "cmd" || key === "command", key === "env", environment && pathListNames.has(key.toUpperCase()))]));
    return item;
  };
  return visit(value) as T;
}
