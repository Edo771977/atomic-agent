import { describe, expect, it, vi } from "vitest";

import { decideModelUpgrade, recommendModelTiers } from "../local-llm/catalog/model-upgrade.js";
import {
  describeRecommendation,
  describeWorkerRecommendation,
  readRoleFlag,
  recommendJson,
  runModelsRecommend,
  workerJson,
  workerRecommendation,
  type RecommendSnapshot,
} from "./models-recommend.js";

function snapshot(activeModelId: string | null): RecommendSnapshot {
  const machine = { ramGb: 32, gpuBudgetGb: 24, freeDiskGb: 120, cpuOnly: false };
  return {
    machine,
    tiers: recommendModelTiers(machine),
    decision: decideModelUpgrade({
      machine,
      activeModelId,
      downloadedIds: ["qwen-3.5-2b"],
      managed: true,
      cloudActive: false,
    }),
    activeModelId,
  };
}

describe("models recommend --json", () => {
  it("keeps the shape the desktop reads", () => {
    const json = recommendJson(snapshot("qwen-3.5-2b"));
    expect(json).toMatchObject({
      version: 1,
      machine: { ramGb: 32, gpuBudgetGb: 24, freeDiskGb: 120, cpuOnly: false },
      activeModelId: "qwen-3.5-2b",
      upgrade: { action: "download", why: null, model: { id: "gemma-4-26b-a4b" } },
    });
    const tiers = json.tiers as Record<string, { id: string; downloadGb: number } | null>;
    expect(Object.keys(tiers)).toEqual(["fast", "balanced", "quality"]);
    expect(tiers.quality?.downloadGb).toBeGreaterThan(14);
  });

  it("says why there is nothing to do", () => {
    expect(recommendJson(snapshot("gemma-4-26b-a4b")).upgrade).toEqual({
      action: "none",
      why: "already_best",
      model: null,
    });
  });
});

describe("models recommend (text)", () => {
  it("names the machine, the three tiers and the next step", () => {
    const text = describeRecommendation(snapshot("qwen-3.5-2b"));
    expect(text).toContain("32 GB RAM");
    expect(text).toMatch(/fast\s+\S+/);
    expect(text).toMatch(/quality\s+gemma-4-26b-a4b/);
    expect(text).toContain("models upgrade");
  });
});

describe("models recommend --role worker", () => {
  it("reads the role flag in both spellings and refuses an unknown role", () => {
    expect(readRoleFlag([])).toBe("default");
    expect(readRoleFlag(["--json"])).toBe("default");
    expect(readRoleFlag(["--role", "worker"])).toBe("worker");
    expect(readRoleFlag(["--role=worker", "--json"])).toBe("worker");
    expect(readRoleFlag(["--role", "default"])).toBe("default");
    expect(readRoleFlag(["--role", "orchestrator"])).toBeNull();
    expect(readRoleFlag(["--role"])).toBeNull();
  });

  it("exits 2 on an unknown role before probing the machine", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await runModelsRecommend(["--role", "boss"])).toBe(2);
      expect(String(err.mock.calls[0]?.[0])).toContain("--role takes default or worker");
    } finally {
      err.mockRestore();
    }
  });

  it("picks the rated worker model where the default picks by rank, and says why", () => {
    const snap = snapshot("qwen-3.5-2b");
    const pick = workerRecommendation(snap.machine, 2);
    expect(pick?.model.id).toBe("qwen-3.5-9b");
    const text = describeWorkerRecommendation(snap, pick);
    expect(text).toContain("32 GB RAM");
    expect(text).toContain("worker model for fusion (2 worker slots):");
    expect(text).toMatch(/qwen-3\.5-9b\s+5\.3 GB/);
    expect(text).toMatch(/why: rated ok as a fusion worker: GAIA L1 52\.8%/);
    expect(text).toMatch(/fits 2 worker slots: needs about [\d.]+ GB of 32 GB/);
    expect(text).toContain("catalog rank 7");
    expect(text).toContain("models pull qwen-3.5-9b");
    // The default text still names the rank-order quality pick.
    expect(describeRecommendation(snap)).toMatch(/quality\s+gemma-4-26b-a4b/);
  });

  it("follows the configured slot count, and auto keeps the default", () => {
    const machine = { ramGb: 64, gpuBudgetGb: 48, freeDiskGb: 200, cpuOnly: false };
    expect(workerRecommendation(machine, "auto")?.slotsWanted).toBe(2);
    expect(workerRecommendation(machine, 4)?.slotsWanted).toBe(4);
  });

  it("adds role and worker to the JSON without changing the default fields", () => {
    const snap = snapshot("qwen-3.5-2b");
    const worker = workerJson(workerRecommendation(snap.machine, 2));
    expect(worker).toMatchObject({
      model: { id: "qwen-3.5-9b" },
      rating: "ok",
      slots: 2,
      slotsWanted: 2,
    });
    expect((worker!.why as string[]).length).toBe(3);
    expect(workerJson(null)).toBeNull();
  });

  it("says when nothing fits", () => {
    const tiny = { ramGb: 4, gpuBudgetGb: null, freeDiskGb: 100, cpuOnly: true };
    const snap = { ...snapshot(null), machine: tiny };
    expect(workerRecommendation(tiny, 2)).toBeNull();
    expect(describeWorkerRecommendation(snap, null)).toContain(
      "worker model for fusion: none fits this machine",
    );
  });
});
