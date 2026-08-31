const WHITEPAPER = `SOL-98 — README.TXT (WHITEPAPER)  v1.1
================================================================================

EXECUTIVE SUMMARY

    SOL-98 is The Million Dollar Homepage reimagined as a permanent,
    on-chain billboard on Solana. 1,000,000 pixels (a 1000×1000 canvas)
    are sold in 10×10 blocks (10,000 blocks) on a bonding curve that
    starts at 0.2 SOL per block. The board is a decentralized ad space
    with a built-in attention game: anyone can burn $PIXEL98 to HIJACK a
    block, and every hijack devalues the target by 5%. Ads are clickable
    — a viewer who taps an ad is redirected to its destination link.

================================================================================

1. TOKENOMICS  ($PIXEL98)

    Total supply:   10,000,000 $PIXEL98 (fixed)
    Launch:         Pump.fun (community fair launch, no pre-sale)
    Allocation:     100% -> pixel block owners (airdrop)

    Allocation:
      +-----------------------------+----------+
      | Pixel block owners (airdrop)|  100.0%  |
      | Team / VCs / treasury       |    0.0%  |
      +-----------------------------+----------+

    There is no team allocation and no pre-mine. Every token is
    distributed to the people who bought the board. The token's
    scarcity comes from the hijack burn (below).

================================================================================

2. DYNAMIC PRICING  (BONDING CURVE)

    price(N) = 0.2 * 1.10^(N-1)          (N is 1-indexed)

    Every PURCHASE raises the next price by 10%. Within a single bulk
    purchase the price ALSO steps up +10% every 10 blocks, so a huge
    area can't be bought entirely at the flat starting price: blocks
    1-10 cost the current price, blocks 11-20 cost +10%, blocks 21-30
    cost +20%, and so on. The price steps up once more after the whole
    purchase completes.

    Examples:
      block #1     0.2000 SOL
      block #2     0.2200 SOL
      block #10    0.4716 SOL
      block #50    21.3438 SOL
      block #100   2,505.5659 SOL   (the curve steepens fast)

    Homage: the 2005 original sold each pixel for $1 (minimum $100 per
    10×10 block). SOL-98 keeps the same 10×10 block structure with a
    0.2 SOL starting price per block.

================================================================================

3. THE 100TH SALE  (PUMP.FUN LAUNCH)

    When the 100th sale happens, the token launches:

      1. The full 10,000,000 $PIXEL98 supply is minted on Pump.fun.
      2. 100% is airdropped to block owners, proportional to blocks.
      3. The liquidity pool opens on Pump.fun.

    A live countdown on the board tracks progress to the 100th sale.

================================================================================

4. DECENTRALIZED AD SPACE

    A purchased block is a permanent, clickable on-chain billboard:
      - the owner's wallet address (proof of ownership)
      - a destination link (click-through redirect)
      - an image / neon GIF
      - a tooltip message
      - a neon template (Cyberpunk Pulse / Matrix Text / Flashing
        Neon Border / Sub-Domain Glitch / Rainbow)

    Blocks can be resold or rented in Market.exe. There is no central
    censor and no takedown.

================================================================================

5. BANNER STUDIO  (Banner.exe)

    Every owner can create a banner WITHOUT uploading an image — a brand
    name + font + animated neon colors + link is enough. Uploaded images
    are auto-optimized (cover-cropped and resized to the exact block
    dimensions). Banners can be downloaded as PNG or placed directly
    onto a purchased area.

================================================================================

6. PIXEL HIJACK  (BURN-TO-CONQUER)

    An owned block can be overtaken by BURNING $PIXEL98 equal to a
    percentage of TOTAL SUPPLY (10,000,000 fixed). The burn rate drops as
    more of the supply is removed from circulation:

        cumulative burned < 25%   ->  1.00%  (100,000 $PIXEL98)
        cumulative burned >= 25%  ->  0.50%  ( 50,000 $PIXEL98)
        cumulative burned >= 50%  ->  0.25%  ( 25,000 $PIXEL98)
        cumulative burned >= 75%  ->  0.10%  ( 10,000 $PIXEL98)

    The hijack payment is split 50/50: half is burned forever and the
    other half is sent to the hijacked block's current owner (fair
    compensation for losing the ad).

    Each successful hijack REDUCES the target's valuation by 5% (0.95x).
    Hijack resets the ad and transfers ownership. (Activated at launch.)

================================================================================

7. PAYMENTS  (SOL + $PIXEL98)

    - SOL: a real SystemProgram.transfer to the treasury.
    - $PIXEL98: listings can also be priced in $PIXEL98 (1 SOL = 1,000
      $PIXEL98 reference rate); $PIXEL98 payments activate at launch.

    Ownership is tied to the buyer's wallet: a block is purchased with
    a real, wallet-signed SOL transfer (SystemProgram.transfer to the
    treasury), and the board records the paying wallet as the owner.

================================================================================

8. AIRDROP RULES

    At launch, tokens are airdropped to block owners proportional to
    block count:

        airdrop(owner) = (blocks_owned / blocks_sold) * total_supply

    (reference estimate: 1,000 $PIXEL98 per block)

================================================================================

NOTE: The token ($PIXEL98) launches on Pump.fun at the 100th sale.
Nothing in this document is financial advice.
`;

export function Whitepaper() {
  return <div className="win98-notepad h-full">{WHITEPAPER}</div>;
}
