import { describe, expect, it } from "vitest";
import { turnProgressFor } from "./turn-checkpoints.js";

describe("turnProgressFor", () => {
  it("records where the turn came from, so /resume offers only the operator's", () => {
    expect(turnProgressFor("hi", { origin: "telegram" }, 1).initial.options).toEqual({ origin: "telegram" });
    expect(turnProgressFor("hi", { origin: "tui", interactive: true }, 1).initial.options).toEqual({ origin: "tui", interactive: true });
    expect(turnProgressFor("hi", {}, 1).initial.options).toEqual({});
  });
});
