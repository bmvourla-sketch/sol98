import { describe, expect, it } from "vitest";

import {
  airdropFor,
  AIRDROP_PER_SPOT,
  HIJACK_VALUATION_DECAY,
  hijackBurnRate,
  hijackCostInTokens,
  LAUNCH_TARGET_SPOTS,
  PIXEL98_PER_SOL,
  splitHijackBurn,
  TOTAL_SUPPLY,
} from "../lib/token";

describe("$PIXEL98 token model", () => {
  it("total supply is 10M (matches airdrop of 1000 x 10k blocks)", () => {
    expect(TOTAL_SUPPLY).toBe(10_000_000);
    expect(AIRDROP_PER_SPOT).toBe(1000);
    expect(PIXEL98_PER_SOL).toBe(1000);
  });

  it("hijack burn rate drops as cumulative burned supply grows", () => {
    expect(hijackBurnRate(0)).toBe(0.01); // <25% → 1%
    expect(hijackBurnRate(0.249)).toBe(0.01);
    expect(hijackBurnRate(0.25)).toBe(0.005); // ≥25% → 0.5%
    expect(hijackBurnRate(0.5)).toBe(0.0025); // ≥50% → 0.25%
    expect(hijackBurnRate(0.75)).toBe(0.001); // ≥75% → 0.10%
    expect(hijackBurnRate(1)).toBe(0.001);
  });

  it("hijack cost = tier rate × total supply, ceiled", () => {
    expect(hijackCostInTokens(0)).toBe(100_000); // 1% of 10M
    expect(hijackCostInTokens(0.25)).toBe(50_000); // 0.5%
    expect(hijackCostInTokens(0.5)).toBe(25_000); // 0.25%
    expect(hijackCostInTokens(0.75)).toBe(10_000); // 0.10%
  });

  it("splitHijackBurn is 50/50 (half burned forever, half to the owner)", () => {
    expect(splitHijackBurn(100_000)).toEqual({ burnedTokens: 50_000, ownerTokens: 50_000 });
    expect(splitHijackBurn(50_000)).toEqual({ burnedTokens: 25_000, ownerTokens: 25_000 });
    // odd costs put the extra token on the owner side, and the halves always sum back
    expect(splitHijackBurn(99_999)).toEqual({ burnedTokens: 49_999, ownerTokens: 50_000 });
    const cost = 123_456;
    const { burnedTokens, ownerTokens } = splitHijackBurn(cost);
    expect(burnedTokens + ownerTokens).toBe(cost);
  });

  it("airdrop = spots * 1000", () => {
    expect(airdropFor(0)).toBe(0);
    expect(airdropFor(3)).toBe(3000);
  });

  it("launch target is the 100th sale", () => {
    expect(LAUNCH_TARGET_SPOTS).toBe(100);
  });

  it("hijack decay is exactly 5%", () => {
    expect(HIJACK_VALUATION_DECAY).toBe(0.05);
  });
});
