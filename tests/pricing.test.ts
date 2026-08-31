import { describe, expect, it } from "vitest";

import {
  areaPrice,
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

describe("areaPrice — no bulk-buy arbitrage", () => {
  it("buying 1 block via areaPrice matches spotPrice", () => {
    expect(areaPrice(0, 1)).toBeCloseTo(spotPrice(1));
    expect(areaPrice(5, 1)).toBeCloseTo(spotPrice(6));
  });

  it("buying N blocks costs the SAME as buying them one at a time in sequence", () => {
    const soldCount = 7;
    const count = 12;
    let sequential = 0;
    for (let k = 1; k <= count; k++) sequential += spotPrice(soldCount + k);
    expect(areaPrice(soldCount, count)).toBeCloseTo(sequential, 9);
  });

  it("matches the closed-form totalRaisedSol difference", () => {
    expect(areaPrice(3, 4)).toBeCloseTo(totalRaisedSol(7) - totalRaisedSol(3), 9);
  });

  it("bulk buying is NOT cheaper per-block than buying one at a time (no arbitrage)", () => {
    const soldCount = 10;
    const count = 5;
    const bulkTotal = areaPrice(soldCount, count);
    // The old (buggy) behavior charged `count * nextSpotPrice(soldCount)` for
    // the whole area — strictly less than the true integrated price for any
    // count > 1, since price only ever goes up. Assert we're NOT doing that.
    const oldBuggyFlatPrice = count * nextSpotPrice(soldCount);
    expect(bulkTotal).toBeGreaterThan(oldBuggyFlatPrice);
  });

  it("zero or negative count costs nothing", () => {
    expect(areaPrice(0, 0)).toBe(0);
    expect(areaPrice(5, -3)).toBe(0);
  });
});
