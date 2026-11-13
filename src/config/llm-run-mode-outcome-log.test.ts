import { describe, expect, it } from "vitest";

import { ConfigValidationError } from "./config-validation-error.js";
import { parseLlmRunModeConfig } from "./llm-run-mode-config.js";

const providers = [{ id: "local-llama", kind: "llama-server" }];

describe("llm.runMode.fusion.outcomeLog", () => {
  it("is absent by default, which reads as on", () => {
    expect(parseLlmRunModeConfig({ fusion: {} }, providers, "llm.runMode").fusion?.outcomeLog).toBeUndefined();
  });

  it("keeps an explicit boolean", () => {
    expect(
      parseLlmRunModeConfig({ fusion: { outcomeLog: false } }, providers, "llm.runMode").fusion,
    ).toEqual({ outcomeLog: false });
  });

  it("refuses anything but a boolean", () => {
    expect(() =>
      parseLlmRunModeConfig({ fusion: { outcomeLog: "no" } }, providers, "llm.runMode"),
    ).toThrow(ConfigValidationError);
  });
});
