// SOL-98 bonding-curve pricing.
//
// 10,000 spots (100 x 100). Spot #1 costs 0.2 SOL. Every purchase raises the
// price of the *next available* spot by 10%, so:
//     price(N) = 0.2 * 1.10^(N-1)     (N is 1-indexed)
export const BOARD_SIZE = 100;
export const TOTAL_SPOTS = BOARD_SIZE * BOARD_SIZE; // 10,000
export const INITIAL_PRICE_SOL = 0.2;
export const PRICE_INCREASE = 0.1; // +10% per spot

/** Price of the Nth spot (1-indexed). */
export function spotPrice(oneBasedIndex: number): number {
  return INITIAL_PRICE_SOL * Math.pow(1 + PRICE_INCREASE, oneBasedIndex - 1);
}

/** Price of the next available spot, given `soldCount` spots already sold. */
export function nextSpotPrice(soldCount: number): number {
  return spotPrice(soldCount + 1);
}

/**
 * Cumulative SOL raised after `soldCount` spots, as a geometric series:
 *   0.2 * (1.1^N - 1) / 0.1
 */
export function totalRaisedSol(soldCount: number): number {
  if (soldCount <= 0) return 0;
  return (
    (INITIAL_PRICE_SOL * (Math.pow(1 + PRICE_INCREASE, soldCount) - 1)) /
    PRICE_INCREASE
  );
}

/**
 * Bulk (multi-block) purchases step the price up every `PRICE_STEP_EVERY`
 * blocks, so a huge area can't be bought entirely at the flat current price.
 */
export const PRICE_STEP_EVERY = 10;

/** Price of the k-th block (0-based) within a single bulk purchase. */
export function bulkBlockPrice(soldCount: number, k: number): number {
  const step = Math.floor(k / PRICE_STEP_EVERY);
  return nextSpotPrice(soldCount) * Math.pow(1 + PRICE_INCREASE, step);
}

/**
 * Total SOL to buy `count` blocks in one purchase. The first 10 blocks cost
 * the current `nextSpotPrice`, the next 10 cost +10%, and so on — the price
 * steps up every 10 blocks (and again, +10%, after the whole purchase).
 */
export function areaPrice(soldCount: number, count: number): number {
  let total = 0;
  for (let k = 0; k < count; k++) total += bulkBlockPrice(soldCount, k);
  return total;
}

/** One price tier of a bulk purchase (for the checkout breakdown). */
export interface BulkPriceTier {
  from: number; // 1-based first block in this tier
  to: number; // 1-based last block in this tier
  count: number;
  unitPrice: number;
  subtotal: number;
}

/** Per-10-block tiers for `count` blocks, with unit price and subtotal. */
export function bulkPriceBreakdown(soldCount: number, count: number): BulkPriceTier[] {
  const tiers: BulkPriceTier[] = [];
  for (let k = 0; k < count; k += PRICE_STEP_EVERY) {
    const to = Math.min(count, k + PRICE_STEP_EVERY);
    const n = to - k;
    const unitPrice = bulkBlockPrice(soldCount, k);
    tiers.push({ from: k + 1, to, count: n, unitPrice, subtotal: n * unitPrice });
  }
  return tiers;
}

/** Human-friendly SOL formatting; shows more decimals for sub-1-SOL amounts. */
export function formatSol(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  if (value >= 1000) return value.toFixed(1);
  if (value >= 10) return value.toFixed(2);
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(4);
}
