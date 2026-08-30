const WHITEPAPER = `SOL-98 — README.TXT (WHITEPAPER)  v1.0
================================================================================

EXECUTIVE SUMMARY

    SOL-98 is The Million Dollar Homepage reimagined as a permanent,
    on-chain billboard on Solana. 1,000,000 pixels (a 1000×1000 canvas)
    are sold in 10×10 blocks (10,000 blocks) on a bonding curve that
    starts at 0.2 SOL per block. The board is a decentralized ad space
    with a built-in attention game: anyone can burn $PIXEL98 to HIJACK a
    block, and every hijack devalues the target by 5%.

================================================================================

1. TOKENOMICS  ($PIXEL98)

    Total supply:   10,000,000 $PIXEL98 (fixed)
    Launch:         Pump.fun (community fair launch, no pre-sale)
    Allocation:     100% -> pixel spot owners (airdrop)

    Allocation:
      +-----------------------------+----------+
      | Pixel spot owners (airdrop) |  100.0%  |
      | Team / VCs / treasury       |    0.0%  |
      +-----------------------------+----------+

    There is no team allocation and no pre-mine. Every token is
    distributed to the people who bought the board — the media
    buyers ARE the community. The token has no utility premine;
    its scarcity comes entirely from the hijack burn (below).

================================================================================

2. DYNAMIC PRICING  (BONDING CURVE)

    price(N) = 0.2 * 1.10^(N-1)          (N is 1-indexed)

    Every purchase raises the price of the NEXT available spot by
    10% — a pure geometric bonding curve. Early buyers pay less,
    late buyers pay more, and the board's implied valuation
    compounds with every block sold. Spots never go down in price.

    Examples:
      block #1     0.2000 SOL
      block #2     0.2200 SOL
      block #10    0.4716 SOL
      block #50    21.3438 SOL
      block #100   2,505.5659 SOL   (the curve steepens fast)

    Homage: the 2005 original sold each pixel for $1 (minimum $100
    per 10×10 block). SOL-98 keeps the same 10×10 block structure
    with a 0.2 SOL starting price per block.

================================================================================

3. THE 10% TIPPING POINT  (PUMP.FUN LAUNCH)

    When 1,000 spots (10% of the board) are sold, the token launches:

      1. The full 10,000,000 $PIXEL98 supply is minted on Pump.fun.
      2. 100% is airdropped to spot owners, proportional to spot count.
      3. The liquidity pool opens on Pump.fun.

    Reaching 10% is the collective "block-holder" milestone: the
    first 1,000 buyers become the founding token distribution.

================================================================================

4. DECENTRALIZED AD SPACE

    A purchased block is a permanent, on-chain billboard. It stores:
      - the owner's wallet address
      - a destination link (click-through)
      - an image / neon GIF
      - a tooltip message
      - a neon banner template (below)

    There is no central censor and no takedown — the board is the
    ad space, and the holders are the media buyers.

================================================================================

5. PIXEL HIJACK  (BURN-TO-CONQUER)

    An owned spot can be overtaken by BURNING $PIXEL98 equal to the
    spot's current SOL valuation (rate: 1 SOL = 1,000 $PIXEL98).

        hijack cost = valuation * 1,000 $PIXEL98

    Each successful hijack REDUCES the target spot's valuation by
    5% (0.95x). A heavily-fought spot becomes cheaper to take over
    over time — a real-time attention auction on-chain. Hijack also
    resets the ad banner and transfers ownership to the attacker.

    Example: a spot valued at 2.0 SOL costs 2,000 $PIXEL98 to hijack.
    After the hijack it is worth 1.9 SOL; the next hijack costs
    1,900 $PIXEL98, and so on.

================================================================================

6. AIRDROP RULES

    At launch, tokens are airdropped to spot owners proportional to
    spot count:

        airdrop(owner) = (spots_owned / spots_sold) * total_supply

    The UI shows a reference estimate of 1,000 $PIXEL98 per spot;
    the definitive rate is recomputed from the full supply at the
    launch snapshot.

================================================================================

7. NEON BANNER TEMPLATES

    Every ad spot ships with four live neon templates:
      - Cyberpunk Pulse      (cyan/magenta pulsing glow)
      - Matrix Text          (green terminal glow)
      - Flashing Neon Border (strobing border)
      - Sub-Domain Glitch    (chromatic glitch effect)

    Templates render live on the board and in the creator's preview
    before the transaction is confirmed.

================================================================================

NOTE: The token ($PIXEL98) launches on Pump.fun once 10% of the
board is filled. Nothing in this document is financial advice.
`;

export function Whitepaper() {
  return <div className="win98-notepad h-full">{WHITEPAPER}</div>;
}
