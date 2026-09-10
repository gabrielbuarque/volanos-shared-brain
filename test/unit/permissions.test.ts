import { describe, expect, it } from "vitest";
import { canReadClearance, entryPermissionClause, identityClearanceFloor, normalizeClearance } from "../../src/lib/permissions";
import type { Identity } from "../../src/lib/identity";

const member = (overrides: Partial<Identity> = {}): Identity => ({
  userId: "u-member",
  role: "member",
  personalWorkspaceId: "personal",
  companyWorkspaceIds: ["company"],
  defaultShare: "",
  clearanceFloor: 8,
  ...overrides,
});

describe("Volanos clearance policy", () => {
  it("normalizes only integer levels from P0 through P12", () => {
    expect(normalizeClearance(0)).toBe(0);
    expect(normalizeClearance("12")).toBe(12);
    expect(normalizeClearance(12.5)).toBeNull();
    expect(normalizeClearance(-1)).toBeNull();
    expect(normalizeClearance(13)).toBeNull();
    expect(normalizeClearance("P8")).toBeNull();
  });

  it("treats P0 as the most restricted level", () => {
    const identity = member();
    expect(identityClearanceFloor(identity)).toBe(8);
    expect(canReadClearance(identity, 7)).toBe(false);
    expect(canReadClearance(identity, 8)).toBe(true);
    expect(canReadClearance(member({ role: "admin" }), 0)).toBe(true);
  });

  it("emits a parameterized ACL predicate instead of interpolating identity", () => {
    const identity = member({ userId: "u-admin-like-?", clearanceFloor: 5 });
    const scope = entryPermissionClause(identity, "e");
    expect(scope.clause).toContain("e.clearance_level >= ?");
    expect(scope.clause).toContain("e.directory_id IS NULL");
    expect(scope.clause).toContain("brain_directory_grants");
    expect(scope.bindings).toEqual([5, identity.userId]);
    expect(scope.clause).not.toContain(identity.userId);
  });
});
