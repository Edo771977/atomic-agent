import { existsSync, readFileSync } from "node:fs";

import {
  dotenvTextValue,
  stripDotenvQuotes,
} from "../config/load-dotenv.js";

export { stripDotenvQuotes };

/**
 * Read a single key's value from a dotenv file without mutating it,
 * using the `loadDotenvFromStateDir` parser itself (`dotenvTextValue`),
 * so an importer compares against exactly the value the agent would
 * load. Returns `undefined` when absent.
 *
 * Shared by the importers that reconcile migrated provider keys against
 * the agent's own `<stateDir>/.env`.
 */
export function readDotenvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return dotenvTextValue(readFileSync(path, "utf8"), key);
}
