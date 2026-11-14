import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { ApprovalGate } from "./approval-gate.js";
import { ReadScopeGrants } from "./read-scope-grants.js";

describe("ReadScopeGrants", () => {
  it("remembers a directory per session and keeps sessions apart", () => {
    const grants = new ReadScopeGrants();
    grants.widen("s-1", resolve("/srv/homes/me/Desktop"));
    expect(grants.rootsFor("s-1")).toEqual([resolve("/srv/homes/me/Desktop")]);
    expect(grants.rootsFor("s-2")).toEqual([]);
  });

  it("keeps the roots a disjoint set: a covered directory is a no-op, a wider one folds the narrower in", () => {
    const grants = new ReadScopeGrants();
    grants.widen("s", resolve("/srv/homes/me/Desktop"));
    grants.widen("s", resolve("/srv/homes/me/Desktop/reports"));
    expect(grants.rootsFor("s")).toEqual([resolve("/srv/homes/me/Desktop")]);
    grants.widen("s", resolve("/srv/homes/me"));
    expect(grants.rootsFor("s")).toEqual([resolve("/srv/homes/me")]);
    // A sibling is its own root; a lookalike prefix is not containment.
    grants.widen("s", resolve("/srv/homes/me-backup"));
    expect(grants.rootsFor("s")).toEqual([resolve("/srv/homes/me"), resolve("/srv/homes/me-backup")]);
  });

  it("ignores a relative directory", () => {
    const grants = new ReadScopeGrants();
    grants.widen("s", "Desktop");
    expect(grants.rootsFor("s")).toEqual([]);
  });

  it("clears one session or every session", () => {
    const grants = new ReadScopeGrants();
    grants.widen("s-1", resolve("/a"));
    grants.widen("s-2", resolve("/b"));
    grants.clear("s-1");
    expect(grants.rootsFor("s-1")).toEqual([]);
    expect(grants.rootsFor("s-2")).toEqual([resolve("/b")]);
    grants.clear();
    expect(grants.rootsFor("s-2")).toEqual([]);
  });

  it("is dropped by the gate's clearSessionGrants, both forms, like the category grants", () => {
    const gate = new ApprovalGate({ emit: () => undefined });
    gate.readScopeGrants.widen("s-1", resolve("/a"));
    gate.readScopeGrants.widen("s-2", resolve("/b"));
    gate.clearSessionGrants("s-1");
    expect(gate.readScopeGrants.rootsFor("s-1")).toEqual([]);
    expect(gate.readScopeGrants.rootsFor("s-2")).toEqual([resolve("/b")]);
    gate.clearSessionGrants();
    expect(gate.readScopeGrants.rootsFor("s-2")).toEqual([]);
  });
});
