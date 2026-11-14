import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const unsupported = (): never => { throw new Error("verification check plan has an unsupported absolute project reference"); };

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
    if (namesSource(filename)) unsupported();
    return text;
  };

  const literal = (text: string): string | undefined => uri(text) ?? native(text);
  const delimiter = (char: string): boolean => /[\s"'`()=;,:<>|&@+]/.test(char);
  const quote = (char: string): boolean => char === '"' || char === "'" || char === "`";

  const scan = (text: string, wholeLiteral: boolean): string => {
    // Whole argv/quoted path literals retain their spaces. Path lists and
    // command bodies still need token scanning; a drive's ':' is not a list.
    const wholeUri = uri(text);
    if (wholeUri !== undefined) return wholeUri;
    if (wholeLiteral && !/[;|<>]/.test(text) && !text.slice(drive(text) ? 2 : 0).includes(":")) {
      const whole = native(text);
      if (whole !== undefined) return whole;
    }
    let result = "";
    for (let index = 0; index < text.length;) {
      const char = text[index]!;
      if (quote(char)) {
        let end = index + 1;
        for (; end < text.length; end++) {
          if (text[end] !== char) continue;
          let escapes = 0;
          for (let previous = end - 1; previous > index && text[previous] === "\\"; previous--) escapes++;
          if (escapes % 2 === 0) break;
        }
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
        while (end < text.length && !/[\s"'`()]/.test(text[end]!)) end++;
        result += uri(text.slice(index, end)) ?? text.slice(index, end);
      } else {
        // A literal root may itself contain spaces/braces/brackets. Consume
        // that known prefix before looking for surrounding syntax.
        const attached = /^-[a-z]+(?=[\/\\]|[a-z]:[\/\\])/i.exec(tail)?.[0] ?? "";
        const pathStart = index + attached.length;
        const rootCandidate = spelling(text.slice(pathStart, pathStart + source.length));
        if (fold(rootCandidate) === fold(source)) end = pathStart + source.length;
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

  const visit = (item: unknown, command = false): unknown => {
    if (typeof item === "string") return scan(item, !command);
    if (Array.isArray(item)) return item.map(child => visit(child));
    if (item !== null && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, key === "cmd" || key === "command")]));
    return item;
  };
  return visit(value) as T;
}
