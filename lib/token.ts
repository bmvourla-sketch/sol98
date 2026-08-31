// $PIXEL98 token model — mock/on-chain-lite constants.
// The token itself launches on Pump.fun at 10% board fill; until then these
// numbers drive the hijack burn, airdrop estimate, and market UI.
export const TOKEN_NAME = "Pixel98";
export const TOKEN_SYMBOL = "$PIXEL98";

/** Mock SOL → $PIXEL98 rate used to price market listings and airdrops. */
export const PIXEL98_PER_SOL = 1000;

/** Mock airdrop allocation: $PIXEL98 granted per owned spot. */
export const AIRDROP_PER_SPOT = 1000;

/** A hijack reduces the target spot's SOL valuation by 5%. */
export const HIJACK_VALUATION_DECAY = 0.05;

/** Token launch trigger: the 100th sale. */
export const LAUNCH_TARGET_SPOTS = 100;

/**
 * Total $PIXEL98 supply — matches the whitepaper (10,000,000 fixed) and the
 * airdrop model (1,000 per block × 10,000 blocks). Until the token is minted
 * this is a MOCK constant used to express hijack costs as a percentage of
 * supply; set it to the real minted supply at Pump.fun launch if it differs.
 */
export const TOTAL_SUPPLY = 10_000_000;

/**
 * Hijack burn tiers. A hijack costs `rate` (a fraction of TOTAL_SUPPLY), and
 * the rate drops as the *cumulative burned* fraction of supply grows:
 *
 *   cumulative burned < 25%  →  1.00%  of supply
 *   cumulative burned ≥ 25%  →  0.50%
 *   cumulative burned ≥ 50%  →  0.25%
 *   cumulative burned ≥ 75%  →  0.10%
 *
 * Early hijacks are expensive; as more of the supply is removed from
 * circulation, overtaking gets cheaper.
 */
export interface HijackBurnTier {
  /** Minimum cumulative burned fraction (of TOTAL_SUPPLY) for this tier. */
  threshold: number;
  /** Hijack cost as a fraction of TOTAL_SUPPLY. */
  rate: number;
}

export const HIJACK_BURN_TIERS: readonly HijackBurnTier[] = [
  { threshold: 0.0, rate: 0.01 },
  { threshold: 0.25, rate: 0.005 },
  { threshold: 0.5, rate: 0.0025 },
  { threshold: 0.75, rate: 0.001 },
];

/** Current hijack burn rate (fraction of supply) for a cumulative burned fraction. */
export function hijackBurnRate(burnedFraction: number): number {
  const clamped = Math.max(0, Math.min(1, burnedFraction));
  let rate = HIJACK_BURN_TIERS[0].rate;
  for (const tier of HIJACK_BURN_TIERS) {
    if (clamped >= tier.threshold) rate = tier.rate;
    else break;
  }
  return rate;
}

/**
 * Total $PIXEL98 tokens required to hijack at the current burn tier — a flat
 * percentage of supply (no longer tied to the target's SOL valuation).
 */
export function hijackCostInTokens(burnedFraction: number): number {
  return Math.ceil(TOTAL_SUPPLY * hijackBurnRate(burnedFraction));
}

/**
 * The 50/50 hijack split: half the payment is burned forever, half is sent to
 * the hijacked spot's current owner (fair compensation for losing the ad).
 */
export function splitHijackBurn(costTokens: number): {
  burnedTokens: number;
  ownerTokens: number;
} {
  const burned = Math.floor(costTokens / 2);
  return { burnedTokens: burned, ownerTokens: costTokens - burned };
}

/** Estimated airdrop for a holder with `spotsOwned` spots. */
export function airdropFor(spotsOwned: number): number {
  return spotsOwned * AIRDROP_PER_SPOT;
}
