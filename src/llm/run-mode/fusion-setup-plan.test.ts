import { describe, expect, it } from "vitest";

import {
  FUSION_SETUP_AUTO_REPLAN,
  FUSION_SETUP_TURN_BUDGET_USD,
  planFusionSetup,
  type FusionSetupFacts,
  type FusionSetupProviderFact,
} from "./fusion-setup-plan.js";

const LOCAL: FusionSetupProviderFact = {
  id: "local-llama", kind: "llama-server", keyState: "unverified", envVar: null, subscriptionCli: null,
};
const OPENROUTER = (keyState: FusionSetupProviderFact["keyState"]): FusionSetupProviderFact => ({
  id: "openrouter", kind: "openrouter", keyState, envVar: "OPENROUTER_API_KEY", subscriptionCli: null,
});

function facts(over: {
  providers?: FusionSetupProviderFact[];
  claude?: FusionSetupFacts["subscriptionClis"]["claude"];
  local?: Partial<FusionSetupFacts["local"]>;
  runMode?: FusionSetupFacts["runMode"];
  active?: string;
} = {}): FusionSetupFacts {
  return {
    stateDir: "/state",
    activeTextProvider: over.active ?? "local-llama",
    providers: over.providers ?? [LOCAL],
    runMode: over.runMode,
    subscriptionClis: { claude: over.claude ?? { state: "missing", fix: "install-cmd" } },
    claudeCliDefaultModel: "cli-default",
    local: {
      mode: "managed",
      url: "http://127.0.0.1:19091",
      externalAnswers: null,
      managedModelId: "m1",
      managedModelOnDisk: true,
      downloadedModelIds: ["m1"],
      recommendedModelId: null,
      ...over.local,
    },
  };
}

describe("planFusionSetup: detection matrix", () => {
  const signedIn = { state: "ready" as const, fix: null };
  const signedOut = { state: "signed_out" as const, fix: "claude   (then /login)" };

  it.each([
    // [cloud key, claude CLI, local model] -> orchestrator | null
    ["key", "ready", true, "claude-cli"],
    ["key", "signed_out", true, "openrouter"],
    ["none", "ready", true, "claude-cli"],
    ["none", "signed_out", true, null],
    ["key", "ready", false, null],
    ["none", "ready", false, null],
  ] as const)("cloud key %s, claude %s, local model %s", (key, claude, model, want) => {
    const plan = planFusionSetup(facts({
      providers: [LOCAL, OPENROUTER(key === "key" ? "present" : "missing")],
      claude: claude === "ready" ? signedIn : signedOut,
      local: model ? {} : { managedModelOnDisk: false, downloadedModelIds: [], recommendedModelId: "rec-1" },
    }));
    if (want === null) {
      expect(plan.ok).toBe(false);
      return;
    }
    expect(plan.ok).toBe(true);
    expect(plan.orchestrator?.providerId).toBe(want);
    expect(plan.worker?.providerId).toBe("local-llama");
  });

  it("a key alone does not beat a signed-in subscription: the CLI first, the key listed", () => {
    const plan = planFusionSetup(facts({ providers: [LOCAL, OPENROUTER("present")], claude: signedIn }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.orchestrator.providerId).toBe("claude-cli");
    expect(plan.orchestrator.priced).toBe(false);
    expect(plan.candidates.map((c) => c.providerId)).toEqual(["claude-cli", "openrouter"]);
  });

  it("the active cloud provider comes before a subscription CLI", () => {
    const plan = planFusionSetup(facts({ providers: [LOCAL, OPENROUTER("present")], claude: signedIn, active: "openrouter" }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.orchestrator.providerId).toBe("openrouter");
    expect(plan.orchestrator.why).toMatch(/active/);
    expect(plan.write.addProvider).toBeUndefined();
    expect(plan.candidates.map((c) => c.providerId)).toEqual(["openrouter", "claude-cli"]);
  });

  it("among keyed providers that are not active, a Best/Balanced model beats a Cheap one", () => {
    const cheap: FusionSetupProviderFact = { ...OPENROUTER("present"), id: "or-cheap", defaultChatModel: "deepseek/deepseek-v4-flash" };
    const best: FusionSetupProviderFact = { ...OPENROUTER("present"), id: "or-best", defaultChatModel: "anthropic/claude-sonnet-5" };
    const plan = planFusionSetup(facts({ providers: [LOCAL, cheap, best] }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.orchestrator).toMatchObject({ providerId: "or-best", tier: "best", model: "anthropic/claude-sonnet-5" });
    expect(plan.candidates.map((c) => c.providerId)).toEqual(["or-best", "or-cheap"]);
    expect(plan.warnings.join("\n")).not.toMatch(/Cheap tier/);
  });

  it("warns when the orchestrator model is in the Cheap tier", () => {
    const cheap: FusionSetupProviderFact = { ...OPENROUTER("present"), defaultChatModel: "deepseek/deepseek-v4-flash" };
    const plan = planFusionSetup(facts({ providers: [LOCAL, cheap], active: "openrouter" }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.orchestrator.tier).toBe("cheap");
    expect(plan.warnings.join("\n")).toMatch(/deepseek\/deepseek-v4-flash is the Cheap tier for openrouter/);
  });

  it("a picked candidate replaces the suggestion; an unknown pick is refused with the ready list", () => {
    const f = facts({ providers: [LOCAL, OPENROUTER("present")], claude: signedIn });
    const plan = planFusionSetup(f, { orchestrator: "openrouter" });
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.orchestrator.providerId).toBe("openrouter");
    expect(plan.write.addProvider).toBeUndefined();
    expect(plan.write.fusion).toMatchObject({ escalation: "advisor", turnBudgetUsd: 1 });
    const bad = planFusionSetup(f, { orchestrator: "nope" });
    if (bad.ok) throw new Error("expected refusal");
    expect(bad.problems.join("\n")).toMatch(/nope cannot orchestrate now; ready: claude-cli, openrouter/);
  });

  it("adds a Claude Code entry with no key when only the CLI is signed in", () => {
    const plan = planFusionSetup(facts({ claude: signedIn }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.write.addProvider).toEqual({
      id: "claude-cli", kind: "subscription-cli", defaultChatModel: "cli-default", subscriptionCli: { cli: "claude" },
    });
    expect(plan.orchestrator.priced).toBe(false);
  });

  it("reuses an existing signed-in subscription entry instead of adding one", () => {
    const sub: FusionSetupProviderFact = { id: "my-claude", kind: "subscription-cli", keyState: "not-needed", envVar: null, subscriptionCli: "claude" };
    const plan = planFusionSetup(facts({ providers: [LOCAL, sub], claude: signedIn }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.orchestrator.providerId).toBe("my-claude");
    expect(plan.write.addProvider).toBeUndefined();
  });
});

describe("planFusionSetup: the stored orchestrator", () => {
  const sub: FusionSetupProviderFact = { id: "my-claude", kind: "subscription-cli", keyState: "not-needed", envVar: null, subscriptionCli: "claude" };
  const storedSub = { fusion: { orchestratorProvider: "my-claude" } };

  it("keeps it when its check is inconclusive, and says it could not be verified", () => {
    const plan = planFusionSetup(facts({
      providers: [LOCAL, sub, OPENROUTER("present")],
      claude: { state: "unknown", fix: null },
      runMode: storedSub,
    }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.orchestrator.providerId).toBe("my-claude");
    expect(plan.warnings.join("\n")).toMatch(/my-claude.*could not be verified/);
  });

  it("replaces it only when it is definitely not ready, and says why", () => {
    const plan = planFusionSetup(facts({
      providers: [LOCAL, sub, OPENROUTER("present")],
      claude: { state: "signed_out", fix: "claude   (then /login)" },
      runMode: storedSub,
    }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.orchestrator.providerId).toBe("openrouter");
    expect(plan.warnings.join("\n")).toMatch(/my-claude.*not signed in.*claude {3}\(then \/login\)/);
  });

  it("a stored keyed provider whose key is gone is replaced with the reason", () => {
    const other: FusionSetupProviderFact = { id: "gem", kind: "gemini", keyState: "present", envVar: "GEMINI_API_KEY", subscriptionCli: null };
    const plan = planFusionSetup(facts({
      providers: [LOCAL, OPENROUTER("missing"), other],
      runMode: { fusion: { orchestratorProvider: "openrouter" } },
    }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.orchestrator.providerId).toBe("gem");
    expect(plan.warnings.join("\n")).toMatch(/openrouter.*no API key/);
  });
});

describe("planFusionSetup: defaults", () => {
  it("priced orchestrator: advisor escalation, one replan and a $1 turn cap", () => {
    const plan = planFusionSetup(facts({ providers: [LOCAL, OPENROUTER("present")] }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.write).toEqual({
      activeTextProvider: "openrouter",
      fusion: {
        orchestratorProvider: "openrouter",
        workerProvider: "local-llama",
        autoReplan: FUSION_SETUP_AUTO_REPLAN,
        escalation: "advisor",
        turnBudgetUsd: FUSION_SETUP_TURN_BUDGET_USD,
      },
    });
    expect(plan.tips.join("\n")).toMatch(/judge is off/);
    expect(plan.tips.join("\n")).toMatch(/isolation is off/);
  });

  it("subscription orchestrator: no dollar cap and no escalation, and says why", () => {
    const plan = planFusionSetup(facts({ claude: { state: "ready", fix: null } }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.write.fusion).not.toHaveProperty("turnBudgetUsd");
    expect(plan.write.fusion).not.toHaveProperty("escalation");
    expect(plan.tips.join("\n")).toMatch(/escalation stays off/);
  });

  it("keeps values the person set and does not overwrite them", () => {
    const plan = planFusionSetup(facts({
      providers: [LOCAL, OPENROUTER("present")],
      runMode: { fusion: { autoReplan: 3, escalation: "off", turnBudgetUsd: 5, judge: "on", isolation: "worktree" } },
    }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.write.fusion).toEqual({ orchestratorProvider: "openrouter", workerProvider: "local-llama" });
    expect(plan.unchanged).toEqual(expect.arrayContaining([
      "llm.runMode.fusion.autoReplan", "llm.runMode.fusion.escalation", "llm.runMode.fusion.turnBudgetUsd",
    ]));
    expect(plan.tips.join("\n")).not.toMatch(/judge is off|isolation is off/);
  });

  it("a value a newer build wrote is the person's: kept, not filled, and no tip for it", () => {
    const plan = planFusionSetup({
      ...facts({ providers: [LOCAL, OPENROUTER("present")] }),
      setAside: { "llm.runMode.fusion.escalation": "future-mode", "llm.runMode.fusion.judge": "strict" },
    });
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.write.fusion).not.toHaveProperty("escalation");
    expect(plan.changes.map((c) => c.key)).not.toContain("llm.runMode.fusion.escalation");
    expect(plan.keptNewer).toEqual([
      { key: "llm.runMode.fusion.escalation", value: "future-mode" },
      { key: "llm.runMode.fusion.judge", value: "strict" },
    ]);
    expect(plan.tips.join("\n")).not.toMatch(/judge is off/);
  });

  it("the $1 turn cap comes with a tip: what it does, 0 for none, and the command", () => {
    const plan = planFusionSetup(facts({ providers: [LOCAL, OPENROUTER("present")] }));
    if (!plan.ok) throw new Error("expected ok");
    const tip = plan.tips.find((t) => t.startsWith("turnBudgetUsd"));
    expect(tip).toMatch(/once a turn has spent \$1/);
    expect(tip).toMatch(/no new delegation or worker/);
    expect(tip).toMatch(/reports what is done/);
    expect(tip).toMatch(/0 means no cap/);
    expect(tip).toMatch(/atomic-agent setup fusion --budget <usd>/);
  });

  it("budgetUsd pins the cap, over a stored value and on 0 too", () => {
    const f = facts({ providers: [LOCAL, OPENROUTER("present")], runMode: { fusion: { turnBudgetUsd: 5 } } });
    const plan = planFusionSetup(f, { budgetUsd: 0 });
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.write.fusion.turnBudgetUsd).toBe(0);
    expect(plan.changes).toContainEqual({ key: "llm.runMode.fusion.turnBudgetUsd", from: 5, to: 0 });
    expect(plan.tips.join("\n")).toMatch(/turnBudgetUsd 0: no spend cap/);
  });

  it("--judge and --isolation opt in through the same write", () => {
    const plan = planFusionSetup(facts({ providers: [LOCAL, OPENROUTER("present")] }), { judge: true, isolation: true });
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.write.fusion).toMatchObject({ judge: "on", isolation: "worktree" });
    expect(plan.tips.join("\n")).not.toMatch(/judge is off|isolation is off/);
  });

  it("is idempotent: the already-applied config plans no changes", () => {
    const plan = planFusionSetup(facts({
      providers: [LOCAL, OPENROUTER("present")],
      active: "openrouter",
      runMode: {
        mode: "fusion",
        fusion: { orchestratorProvider: "openrouter", workerProvider: "local-llama", autoReplan: 1, escalation: "advisor", turnBudgetUsd: 1 },
      },
    }));
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.changes).toEqual([]);
  });
});

describe("planFusionSetup: refusals say what to do", () => {
  it("missing key names the variable and the .env path, never a value", () => {
    const plan = planFusionSetup(facts({ providers: [LOCAL, OPENROUTER("missing")], claude: { state: "signed_out", fix: "claude   (then /login)" } }));
    if (plan.ok) throw new Error("expected refusal");
    const text = plan.problems.join("\n");
    expect(text).toMatch(/openrouter has no API key: put OPENROUTER_API_KEY=… in \/state\/\.env/);
    expect(text).toMatch(/Manage › LLM › Cloud/);
    expect(text).toMatch(/not signed in; run: claude/);
  });

  it("claude not installed: gives the install command", () => {
    const plan = planFusionSetup(facts());
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.problems.join("\n")).toMatch(/not installed.*install-cmd/);
  });

  it("no local model: prints the exact download command", () => {
    const plan = planFusionSetup(facts({
      providers: [LOCAL, OPENROUTER("present")],
      local: { managedModelOnDisk: false, downloadedModelIds: [], recommendedModelId: "rec-1" },
    }));
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.orchestrator?.providerId).toBe("openrouter");
    expect(plan.problems.join("\n")).toMatch(/atomic-agent models pull rec-1 --background/);
  });

  it("another model on disk: names the switch command", () => {
    const plan = planFusionSetup(facts({
      providers: [LOCAL, OPENROUTER("present")],
      local: { managedModelOnDisk: false, downloadedModelIds: ["m2"] },
    }));
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.problems.join("\n")).toMatch(/atomic-agent models use m2/);
  });

  it("an external llama-server counts as the worker leg", () => {
    const plan = planFusionSetup(facts({
      providers: [LOCAL, OPENROUTER("present")],
      local: { mode: "external", url: "http://10.0.0.2:8080", externalAnswers: true, managedModelOnDisk: false, downloadedModelIds: [] },
    }));
    expect(plan.ok).toBe(true);
    expect(plan.worker?.why).toMatch(/10\.0\.0\.2/);
  });

  it("an external server that does not answer points at the built-in engine", () => {
    const plan = planFusionSetup(facts({
      providers: [LOCAL, OPENROUTER("present")],
      local: { mode: "external", url: "http://127.0.0.1:9931", externalAnswers: false, managedModelId: null, managedModelOnDisk: false, downloadedModelIds: [], recommendedModelId: "rec-1" },
    }));
    if (plan.ok) throw new Error("expected refusal");
    const text = plan.problems.join("\n");
    expect(text).toMatch(/No local model server answers at http:\/\/127\.0\.0\.1:9931/);
    expect(text).toMatch(/models pull rec-1 --background[\s\S]*models use rec-1/);
  });
});
