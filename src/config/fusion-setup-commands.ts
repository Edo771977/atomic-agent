import { getConfig, resetConfigCache } from "./config-cache.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "./config-file.js";
import { parseUserConfigFile, type UserConfigFile } from "./config-schema.js";
import type { UserLlmProviderEntry } from "./llm-config.js";
import { readLlmBlockOrDefault } from "./llm-provider-commands.js";
import type { UserLlmFusionConfig } from "./llm-run-mode-config.js";
import { defaultProviderModelMode } from "./model-mode.js";

export interface FusionSetupConfigChange {
  /** Added to `llm.providers` when no entry with its id exists yet. */
  readonly addProvider?: UserLlmProviderEntry;
  /** The orchestrator leg; fusion holds only while it is the active provider. */
  readonly activeTextProvider: string;
  /** Merged over the stored `llm.runMode.fusion`. */
  readonly fusion: Partial<UserLlmFusionConfig>;
}

/**
 * Switch the config to Fusion in ONE validated write: an optional new
 * provider entry, the active provider, `llm.runMode.mode = "fusion"` and
 * the fusion block merge. One write for the same reason as the TUI's run
 * mode persistence: a file whose mode says fusion while the active
 * provider says otherwise resolves to a different mode than it claims.
 *
 * The result is re-parsed through `parseUserConfigFile` before anything
 * is written, so a leg that names an unknown provider throws
 * `ConfigValidationError` and leaves the file as it was. A new entry
 * carries no key: this never writes a credential.
 */
export function applyFusionSetupInConfig(change: FusionSetupConfigChange): UserConfigFile {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  const add = change.addProvider;
  const providers =
    add && !llm.providers.some((p) => p.id === add.id)
      ? [...llm.providers, { ...add, modelMode: add.modelMode ?? defaultProviderModelMode(add) }]
      : llm.providers;
  const next: UserConfigFile = {
    ...file,
    llm: {
      ...llm,
      providers,
      activeTextProvider: change.activeTextProvider,
      runMode: {
        ...llm.runMode,
        mode: "fusion",
        fusion: { ...llm.runMode?.fusion, ...change.fusion },
      },
    },
  };
  const validated = parseUserConfigFile(JSON.parse(JSON.stringify(next)) as unknown);
  writeUserConfigFileSync(path, next);
  resetConfigCache();
  return validated;
}
