import { describe, expect, it } from "vitest";
import { parseUserConfigFile, USER_CONFIG_DEFAULTS } from "../../src/config/config-schema.js";
import { buildMemoryConfig } from "./memory-profiles.js";

describe("memory campaign approval configuration", () => {
  it.each(["on", "off"] as const)("serializes an unattended %s profile using the current approval policy", (profile) => {
    const originalLevel = USER_CONFIG_DEFAULTS.agent.approvalLevel;
    const config = buildMemoryConfig(profile, { llamaUrl: "http://127.0.0.1:18991" });
    const parsed = parseUserConfigFile(JSON.parse(JSON.stringify(config)));
    expect(parsed.agent.approvalLevel).toBe(5);
    expect(Object.hasOwn(config.agent, "approvalRequired")).toBe(false);
    expect(USER_CONFIG_DEFAULTS.agent.approvalLevel).toBe(originalLevel);
  });
});
