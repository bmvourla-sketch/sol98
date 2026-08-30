// SOL-98 bonding-curve pricing.
//
// 10,000 spots (100 x 100). Spot #1 costs 0.2 SOL. Every purchase raises the
// price of the *next available* spot by 10%, so:
//     price(N) = 0.2 * 1.10^(N-1)     (N is 1-indexed)
export const BOARD_SIZE = 200;
export const TOTAL_SPOTS = BOARD_SIZE * BOARD_SIZE; // 40,000
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

/** Human-friendly SOL formatting; shows more decimals for sub-1-SOL amounts. */
export function formatSol(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  if (value >= 1000) return value.toFixed(1);
  if (value >= 10) return value.toFixed(2);
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(4);
}
