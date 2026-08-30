import { describe, expect, it } from "vitest";

import {
  INITIAL_PRICE_SOL,
  nextSpotPrice,
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

  it("each spot is 10% more than the previous", () => {
    expect(spotPrice(2)).toBeCloseTo(0.22);
    expect(spotPrice(3)).toBeCloseTo(0.242);
  });

  it("spot #100 matches 0.2 * 1.1^99", () => {
    expect(spotPrice(100)).toBeCloseTo(0.2 * Math.pow(1.1, 99));
  });

  it("nextSpotPrice uses soldCount + 1", () => {
    expect(nextSpotPrice(0)).toBeCloseTo(0.2);
    expect(nextSpotPrice(1)).toBeCloseTo(0.22);
  });

  it("total raised is the geometric sum", () => {
    expect(totalRaisedSol(0)).toBe(0);
    expect(totalRaisedSol(1)).toBeCloseTo(0.2);
    expect(totalRaisedSol(2)).toBeCloseTo(0.42);
  });
});
