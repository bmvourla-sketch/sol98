import { describe, expect, it } from "vitest";

import {
  airdropFor,
  AIRDROP_PER_SPOT,
  HIJACK_VALUATION_DECAY,
  hijackCostInTokens,
  LAUNCH_TARGET_SPOTS,
  PIXEL98_PER_SOL,
} from "../lib/token";

describe("$PIXEL98 token model", () => {
  it("hijack cost = valuation * 1000, ceiled", () => {
    expect(hijackCostInTokens(0.5)).toBe(500);
    expect(hijackCostInTokens(1)).toBe(1000);
    expect(hijackCostInTokens(2.5)).toBe(2500);
  });

  it("airdrop = spots * 1000", () => {
    expect(airdropFor(0)).toBe(0);
    expect(airdropFor(3)).toBe(3000);
  });

  it("launch target is the 100th sale", () => {
    expect(LAUNCH_TARGET_SPOTS).toBe(100);
    expect(PIXEL98_PER_SOL).toBe(1000);
    expect(AIRDROP_PER_SPOT).toBe(1000);
  });

  it("hijack decay is exactly 5%", () => {
    expect(HIJACK_VALUATION_DECAY).toBe(0.05);
  });
});
