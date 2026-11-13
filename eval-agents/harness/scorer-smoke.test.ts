import { expect, test } from "vitest";
import { loadGaiaRows } from "./load-gaia-rows.js";
import { questionScorer } from "./score-gaia.js";

// Explicit scorer-only smoke. It supplies no evidence that an agent ran.
test("GAIA scorer-only smoke fixtures are self-consistent", () => {
  const rows = loadGaiaRows({ source: "fixtures" });
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(questionScorer(row["Final answer"], row["Final answer"])).toBe(true);
  }
});
