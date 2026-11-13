import { posix as pathPosix, win32 as pathWin32 } from "node:path";

import type { InstallSource } from "../update/install-source.js";

/**
 * What a target is, so the UI can group and colour it without parsing
 * paths. `data` is everything the operator produced — the config, the
 * memory fabric, sessions, downloaded weights — and is the half that
 * cannot be reinstalled. `program` is what the installer put there and
 * what `install.sh` would put back.
 */
export type UninstallTargetGroup = "data" | "program";

export interface UninstallTarget {
  /** Absolute path to remove, file or directory. */
  readonly path: string;
  /** One-line description shown in the confirm screens. */
  readonly label: string;
  readonly group: UninstallTargetGroup;
}

export interface UninstallPlanInput {
  /** `getConfig().paths.stateDir` — honours `ATOMIC_AGENT_STATE_DIR`. */
  readonly stateDir: string;
  /** `process.execPath`. A dev run points at `node` and installs nothing. */
  readonly execPath: string;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  /**
   * Whether `<installDir>/atomic-agent` exists. Every `program` target is
   * gated on it: the install dir is shared (`~/.local/bin` holds other
   * people's tools), so `node_modules` and `vendor` next to *our* binary
   * are ours to delete, and the same names next to somebody else's are
   * not. The caller stats it — this module stays pure.
   */
  readonly binaryPresent: boolean;
  /**
   * The Linux package that installed the binary, when one did
   * (`src/update/install-source.ts`). The package manager owns the program
   * half then: removing `/usr/lib/atomic-agent` by hand would leave dpkg's
   * or rpm's database naming files that are gone, so the plan lists data
   * only and the caller names the package manager's remove command.
   */
  readonly installSource?: InstallSource;
}

/**
 * Directories the installer drops beside the binary. Kept in the same
 * order `install.sh` writes them so the two lists can be diffed by eye
 * when either changes.
 */
const INSTALLED_ASSET_DIRS: readonly string[] = [
  "grammars",
  "starter-skills",
  "assets",
  "vendor",
  "prebuilds",
  "node_modules",
];

/**
 * The path flavour to reason in. Explicit rather than `node:path`'s
 * ambient default for the same reason `run-app-update.ts` does it: a
 * Windows `execPath` has to parse correctly in a test running on a Mac,
 * and on the real machine the two agree anyway.
 */
function pathFor(platform: NodeJS.Platform): typeof pathPosix {
  return platform === "win32" ? pathWin32 : pathPosix;
}

/** Where `runAppUpdate` and `install.sh` agree the program lives. */
export function installDirFor(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).dirname(execPath);
}

/**
 * Whether `execPath` is the installed binary rather than a dev runtime.
 * Same test `canSelfUpdate` makes, and for the same reason: under `node`
 * or `tsx` there is nothing installed to remove.
 */
export function isInstalledBinary(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const exe = pathFor(platform).basename(execPath).toLowerCase();
  if (exe.startsWith("node") || exe.startsWith("tsx")) return false;
  return exe.startsWith("atomic-agent");
}

/**
 * Everything `atomic-agent uninstall` would remove, in the order it is
 * shown and removed: data first, program second.
 *
 * Pure — no `fs`, no `process`. The caller stats the result to fill in
 * sizes (`measureUninstallPlan`) and to drop what does not exist.
 */
export function planUninstallTargets(
  input: UninstallPlanInput,
): readonly UninstallTarget[] {
  const path = pathFor(input.platform);
  const targets: UninstallTarget[] = [
    {
      path: path.resolve(input.stateDir),
      label: "config, memory, sessions, tasks, traces, downloaded models",
      group: "data",
    },
    {
      path: path.resolve(input.homeDir, "Documents", "atomic-agent-debug"),
      label: "debug bundles written by /dump",
      group: "data",
    },
  ];

  if (
    !isInstalledBinary(input.execPath, input.platform) ||
    !input.binaryPresent ||
    input.installSource !== undefined
  ) {
    // A dev checkout is uninstalled with `git`, a package with the package
    // manager; saying so is the whole point of returning data-only rather
    // than guessing an install dir.
    return targets;
  }

  const installDir = installDirFor(input.execPath, input.platform);
  const exeSuffix = input.platform === "win32" ? ".exe" : "";
  targets.push({
    path: path.resolve(installDir, `atomic-agent${exeSuffix}`),
    label: "the binary",
    group: "program",
  });
  // install.ps1 writes the alias as a `.cmd` shim, not a second copy of
  // the binary, so the Windows name differs from the binary's suffix.
  const aliasSuffix = input.platform === "win32" ? ".cmd" : "";
  targets.push({
    path: path.resolve(installDir, `atag${aliasSuffix}`),
    label: "the short alias",
    group: "program",
  });
  for (const dir of INSTALLED_ASSET_DIRS) {
    targets.push({
      path: path.resolve(installDir, dir),
      label: `installed ${dir}`,
      group: "program",
    });
  }
  return targets;
}

function isWindowsNamespace(value: string): boolean {
  const slashes = value.replace(/\//g, "\\");
  return /^\\{2,}[?.](?:\\|$)/.test(slashes) || /^\\+\?\?(?:\\|$)/.test(slashes);
}

/**
 * Paths that must never be handed to `rm -rf`, however we got there.
 *
 * This is a backstop, not the design: the plan above only ever names
 * paths it built itself. But it builds them out of `process.execPath`
 * and an env var, and the cost of one of those being empty or `/` is
 * the operator's home directory. A denylist that costs a string compare
 * is the right price for that.
 */
export function isSafeToRemove(
  input: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const path = pathFor(platform);
  // Device/extended namespaces do not share ordinary DOS/UNC root and
  // alias semantics. Reject them for either operand rather than risk
  // comparing a protected home with a spelling of a different root.
  if (platform === "win32" && [input, homeDir, path.resolve(input), path.resolve(homeDir)].some(isWindowsNamespace)) return false;
  const target = platform === "win32" ? windowsOpenedPath(input) : path.resolve(input);
  const home = platform === "win32" ? windowsOpenedPath(homeDir) : path.resolve(homeDir);
  const fromHome = path.relative(home, target);
  if (fromHome.length === 0) return false;
  const toHome = path.relative(target, home);
  if (!path.isAbsolute(toHome) && toHome !== ".." && !toHome.startsWith(`..${path.sep}`)) return false;
  // Remove the parsed root before counting: a Windows drive letter or
  // UNC server/share prefix is not an ordinary directory component.
  const root = path.parse(target).root;
  const belowRoot = path.relative(root, target);
  if (belowRoot.length === 0) return false;
  const segments = belowRoot.split(path.sep).filter((part) => part.length > 0);
  // `/usr`, `/etc`, `C:\Windows` — one segment deep and outside home is
  // never something we installed.
  const insideHome = !path.isAbsolute(fromHome) && fromHome !== ".." && !fromHome.startsWith(`..${path.sep}`);
  if (segments.length < 2 && !insideHome) return false;
  // An 8.3 short name (`OPERAT~1`) cannot be resolved lexically: at or above
  // home's depth it might be home or one of its ancestors, so refuse it, in
  // the target or in home itself (a short-named home's long name is home).
  if (platform === "win32" && segments.length <= homeDepth(home) && [...segments, ...homeSegments(home)].some((part) => SHORT_NAME.test(part))) return false;
  return true;
}

const SHORT_NAME = /~\d+(?:\.[^.]{0,3})?$/;

function homeSegments(home: string): string[] {
  return pathWin32.relative(pathWin32.parse(home).root, home).split(pathWin32.sep).filter((part) => part.length > 0);
}

function homeDepth(home: string): number {
  return homeSegments(home).length;
}

/**
 * The path a Win32 open reaches: trailing dots and spaces of each
 * component are dropped, and a `:stream` suffix (`::$DATA` or a named
 * stream) still names the same file or folder.
 */
function windowsOpenedPath(value: string): string {
  const resolved = pathWin32.resolve(value);
  const { root } = pathWin32.parse(resolved);
  const parts = resolved.slice(root.length).split("\\").filter((part) => part.length > 0).map((part) => {
    const colon = part.indexOf(":");
    const name = (colon === -1 ? part : part.slice(0, colon)).replace(/[. ]+$/, "");
    return name.length === 0 ? part : name;
  });
  return root + parts.join("\\");
}
