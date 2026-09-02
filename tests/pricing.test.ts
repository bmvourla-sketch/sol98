import { describe, expect, it } from "vitest";

import {
  areaPrice,
  bulkBlockPrice,
  bulkPriceBreakdown,
  INITIAL_PRICE_SOL,
  nextSpotPrice,
  PRICE_STEP_EVERY,
  spotPrice,
  totalRaisedSol,
  TOTAL_SPOTS,
} from "../lib/pricing";

describe("bonding curve", () => {
  it("board is 10,000 spots at 0.2 SOL start", () => {
    expect(TOTAL_SPOTS).toBe(10000);
    expect(INITIAL_PRICE_SOL).toBe(0.2);
  });

  it("spot #1 costs 0.2 SOL", () => {
    expect(spotPrice(1)).toBeCloseTo(0.2);
  });

  it("each spot is 5% more than the previous", () => {
    expect(spotPrice(2)).toBeCloseTo(0.21);
    expect(spotPrice(3)).toBeCloseTo(0.2205);
  });

  it("spot #100 matches 0.2 * 1.05^99", () => {
    expect(spotPrice(100)).toBeCloseTo(0.2 * Math.pow(1.05, 99));
  });

  it("nextSpotPrice uses soldCount + 1", () => {
    expect(nextSpotPrice(0)).toBeCloseTo(0.2);
    expect(nextSpotPrice(1)).toBeCloseTo(0.21);
  });

  it("total raised is the geometric sum", () => {
    expect(totalRaisedSol(0)).toBe(0);
    expect(totalRaisedSol(1)).toBeCloseTo(0.2);
    expect(totalRaisedSol(2)).toBeCloseTo(0.41);
  });
});

describe("areaPrice — steps +5% every 10 blocks", () => {
  it("buying 1 block costs the current spot price", () => {
    expect(areaPrice(0, 1)).toBeCloseTo(0.2);
    expect(areaPrice(5, 1)).toBeCloseTo(nextSpotPrice(5));
  });

  it("first 10 blocks cost the flat current price", () => {
    expect(areaPrice(0, 10)).toBeCloseTo(2.0); // 10 × 0.2
  });

  it("blocks 11-20 cost +5%", () => {
    // 10 @ 0.2 + 10 @ 0.21 = 2.0 + 2.1 = 4.1
    expect(areaPrice(0, 20)).toBeCloseTo(4.1);
  });

  it("bulkBlockPrice steps every 10 blocks", () => {
    expect(bulkBlockPrice(0, 0)).toBeCloseTo(0.2); // block #1
    expect(bulkBlockPrice(0, 9)).toBeCloseTo(0.2); // block #10
    expect(bulkBlockPrice(0, 10)).toBeCloseTo(0.21); // block #11
    expect(bulkBlockPrice(0, 20)).toBeCloseTo(0.2205); // block #21
  });

  it("uses the next spot price as the base when blocks are already sold", () => {
    expect(areaPrice(1, 10)).toBeCloseTo(2.1); // 10 × 0.21
  });

  it("bulkPriceBreakdown returns one tier per 10 blocks", () => {
    const tiers = bulkPriceBreakdown(0, 25);
    expect(tiers).toHaveLength(3);
    expect(tiers[0]).toMatchObject({ from: 1, to: 10, count: 10 });
    expect(tiers[1]).toMatchObject({ from: 11, to: 20, count: 10 });
    expect(tiers[2]).toMatchObject({ from: 21, to: 25, count: 5 });
    expect(tiers[0].unitPrice).toBeCloseTo(0.2);
    expect(tiers[1].unitPrice).toBeCloseTo(0.21);
    expect(tiers[2].unitPrice).toBeCloseTo(0.2205);
    expect(PRICE_STEP_EVERY).toBe(10);
  });

  it("zero or negative count costs nothing", () => {
    expect(areaPrice(0, 0)).toBe(0);
    expect(areaPrice(5, -3)).toBe(0);
  });
});
