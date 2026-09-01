// $PIXEL98 token model — mock/on-chain-lite constants.
// The token itself launches on Pump.fun at 10% board fill; until then these
// numbers drive the hijack burn, airdrop estimate, and market UI.
export const TOKEN_NAME = "Pixel98";
export const TOKEN_SYMBOL = "$PIXEL98";

/** Mock SOL → $PIXEL98 rate used to price market listings and airdrops. */
export const PIXEL98_PER_SOL = 100_000;

/** Mock airdrop allocation: $PIXEL98 granted per owned spot. */
export const AIRDROP_PER_SPOT = 100_000;

/** A hijack reduces the target spot's SOL valuation by 5%. */
export const HIJACK_VALUATION_DECAY = 0.05;

/**
 * Hijack cost scales with the target's own valuation (see
 * HIJACK_VALUATION_DECAY) relative to a board's base block price — capped so
 * an extreme late-bonding-curve pixel doesn't require an unreasonable
 * fraction of total supply to take over. A valuation at the cap or above
 * costs the same as exactly the cap; it never costs MORE than this many
 * times the tier's flat rate.
 */
export const HIJACK_VALUATION_RATIO_CAP = 20;

/** Token launch trigger: the 100th sale. */
export const LAUNCH_TARGET_SPOTS = 100;

/**
 * Total $PIXEL98 supply — matches Pump.fun's standard self-serve launch
 * mint (every Pump.fun token mints a fixed 1,000,000,000 supply; there is
 * no way to launch a smaller custom supply through the standard flow) and
 * the airdrop model (100,000 per block × 10,000 blocks). Until the token
 * is minted this is a MOCK constant used to express hijack costs as a
 * percentage of supply; it already matches the real mint Pump.fun will
 * produce at launch.
 */
export const TOTAL_SUPPLY = 1_000_000_000;

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
 * Total $PIXEL98 tokens required to hijack a specific spot: the global tier
 * rate (see HIJACK_BURN_TIERS — cheaper as more supply is burned) SCALED by
 * that spot's own current valuation relative to `referenceSol` (a board's
 * base block price — see INITIAL_PRICE_SOL / BOARD_BLOCK_BASE_SOL).
 *
 * This is what makes HIJACK_VALUATION_DECAY a real economic effect and not
 * just a displayed number: a spot ground down by repeated hijacks — or
 * simply bought cheap early on a bonding curve — costs proportionally LESS
 * to take over than a spot currently worth more than the base price; a spot
 * worth more than the base price costs proportionally MORE. The ratio is
 * capped (HIJACK_VALUATION_RATIO_CAP) so a spot far out on an exponential
 * bonding curve doesn't require an unreasonable fraction of total supply,
 * and floored at 1 token so a hijack is never free.
 */
export function hijackCostInTokens(burnedFraction: number, valuationSol: number, referenceSol: number): number {
  const baseRate = hijackBurnRate(burnedFraction);
  const rawRatio = referenceSol > 0 ? valuationSol / referenceSol : 1;
  const ratio = Math.min(HIJACK_VALUATION_RATIO_CAP, Math.max(0, rawRatio));
  return Math.max(1, Math.ceil(TOTAL_SUPPLY * baseRate * ratio));
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
