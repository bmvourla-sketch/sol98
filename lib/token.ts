// $PIXEL98 token model — mock/on-chain-lite constants.
// The token itself launches on Pump.fun at 10% board fill; until then these
// numbers drive the hijack burn, airdrop estimate, and market UI.
export const TOKEN_SYMBOL = "$PIXEL98";

/** Mock SOL → $PIXEL98 rate used to price a hijack burn. */
export const PIXEL98_PER_SOL = 1000;

/** Mock airdrop allocation: $PIXEL98 granted per owned spot. */
export const AIRDROP_PER_SPOT = 1000;

/** A hijack reduces the target spot's SOL valuation by 5%. */
export const HIJACK_VALUATION_DECAY = 0.05;

/** Token launch trigger: the 100th spot sold. */
export const LAUNCH_TARGET_SPOTS = 100;

/** $PIXEL98 tokens required to hijack a spot worth `valuationSol` SOL. */
export function hijackCostInTokens(valuationSol: number): number {
  return Math.ceil(valuationSol * PIXEL98_PER_SOL);
}

/** Estimated airdrop for a holder with `spotsOwned` spots. */
export function airdropFor(spotsOwned: number): number {
  return spotsOwned * AIRDROP_PER_SPOT;
}
