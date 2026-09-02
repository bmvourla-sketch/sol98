const WHITEPAPER = `SOL-98 — README.TXT (WHITEPAPER)  v1.5
================================================================================

EXECUTIVE SUMMARY

    SOL-98 is The Million Dollar Homepage reimagined for Solana: a
    1000×1000 pixel canvas (1,000,000 pixels) sold in 10×10 blocks
    (10,000 blocks) on a bonding curve that starts at 0.2 SOL per
    block. Every purchase is a real, wallet-signed SOL payment,
    verified before ownership changes hands — see section 10 for
    exactly what that guarantees and what it doesn't. The board is a
    decentralized ad space with a built-in attention game: every
    purchase — the first sale or a later "Buy at Valuation" (section
    7) — raises a block's valuation 10%, and anyone can burn $PIXEL98
    to HIJACK a block, which devalues it 5% and hands it to a new
    owner. Buy and hijack form a closed cycle that repeats for every
    block, for as long as the board exists. Ads are clickable — a
    viewer who taps an ad is redirected to its destination link.

================================================================================

1. TOKENOMICS  ($PIXEL98)

    Total supply:   1,000,000,000 $PIXEL98 (fixed)
    Launch:         Pump.fun (standard self-serve launch, no pre-sale)
    Allocation:     100% -> pixel block owners (airdrop), 0% team/dev

      +-----------------------------+----------+
      | Pixel block owners (airdrop)|  100.0%  |
      | Team / VCs / treasury       |    0.0%  |
      +-----------------------------+----------+

    1,000,000,000 is not a number SOL-98 chose — it is Pump.fun's fixed
    mint for every standard token launch. Their self-serve flow has no
    option to mint a smaller custom supply, so $PIXEL98 uses that same
    1B figure to be deployable exactly as described in this document.

    PUMP.FUN LAUNCH MECHANICS  (what actually happens at the 100th sale)

      - Bonding curve seed: 30 SOL + ~1.073B virtual tokens, priced by
        a constant-product curve (x*y=k). Price rises as real tokens
        are bought off the curve.
      - Of the 1,000,000,000 real supply: ~793.1M (79.31%) is sold
        publicly on the curve; ~206.9M (20.69%) is reserved and
        deposited into the post-graduation liquidity pool.
      - Graduation: once the curve has raised ~85 real SOL (~$69,000
        market cap at typical SOL prices), the token graduates off the
        curve.
      - Migration: the reserved tokens plus the raised SOL move into a
        new PumpSwap pool (Pump.fun's own AMM, not Raydium). LP tokens
        are burned automatically on migration — that liquidity can
        never be pulled by anyone, including the SOL-98 team.
      - Fees: 0 SOL to create the token; a one-time ~0.015 SOL
        migration fee. Bonding-curve trading fee is 1.25% total (0.30%
        to the creator, 0.95% to the protocol). Post-graduation,
        PumpSwap fees taper with market cap, from 1.25% down to 0.30%
        at the highest tier.
      - No dev/creator token allocation exists in Pump.fun's contract:
        every one of the 1,000,000,000 tokens is either sold publicly
        on the curve or reserved for the LP — none are pre-mined to a
        team wallet. The SOL-98 team's revenue is the 0.30% creator
        trading fee, not a token grant.

    NOTE: because the curve sale is public and permissionless, the 1B
    mint isn't allocated directly to block owners at the protocol
    level. The "100% -> pixel block owners" airdrop (section 9) is
    executed by the SOL-98 team as a post-graduation distribution to
    the wallets recorded as block owners at the 100th sale, funded
    from curve buys / creator fee revenue — it is a SOL-98 commitment
    layered on top of the standard launch, not a Pump.fun built-in.

    There is no team pre-mine. The token's scarcity beyond the initial
    mint comes from the hijack burn (below).

================================================================================

2. DYNAMIC PRICING  (BONDING CURVE)

    price(N) = 0.2 * 1.05^(N-1)          (N is 1-indexed)

    Every PURCHASE raises the next price by 5%. Within a single bulk
    purchase the price ALSO steps up +5% every 10 blocks, so a huge
    area can't be bought entirely at the flat starting price: blocks
    1-10 cost the current price, blocks 11-20 cost +5%, blocks 21-30
    cost +10%, and so on. The price steps up once more after the whole
    purchase completes.

    Examples:
      block #1     0.2000 SOL
      block #2     0.2100 SOL
      block #10    0.3103 SOL
      block #50    2.1843 SOL
      block #100   25.0486 SOL

    (Was a +10%/sale curve that put block #100 at 2,505 SOL — lowered
    to +5% so late blocks stay expensive without being absurd.)

    Homage: the 2005 original sold each pixel for $1 (minimum $100 per
    10×10 block). SOL-98 keeps the same 10×10 block structure with a
    0.2 SOL starting price per block.

    NOTE: This N-indexed curve prices a block only for its FIRST sale
    (still-unsold blocks from the original 10,000-block pool). Once a
    block has been sold once, all further price changes happen
    per-block through its own VALUATION (section 7) — independent of
    the global sale counter N.

================================================================================

3. THE 100TH SALE  (PUMP.FUN LAUNCH)

    When the 100th sale happens, the token launches:

      1. The full 1,000,000,000 $PIXEL98 supply is minted on Pump.fun
         and public bonding-curve trading opens (see section 1).
      2. The wallets holding blocks at that moment are snapshotted;
         100% of the airdrop allocation is distributed to them,
         proportional to blocks owned (section 9).
      3. Once the curve graduates, the liquidity pool opens on
         PumpSwap and its LP tokens are burned.

    A live countdown on the board tracks progress to the 100th sale.

================================================================================

4. DECENTRALIZED AD SPACE

    A purchased block is a clickable billboard, paid for with a real
    Solana transaction and recorded against your wallet:
      - the owner's wallet address (proof of purchase — verifiable on
        Solana, see section 10)
      - a destination link (click-through redirect)
      - an image / neon GIF
      - a tooltip message
      - a neon template (Cyberpunk Pulse / Matrix Text / Flashing
        Neon Border / Sub-Domain Glitch / Rainbow / Sequential Flash)

    Blocks can be resold or rented in Market.exe, bought outright at
    valuation (section 7), or hijacked (section 6) — ownership is
    contested, not permanent. There is no central censor and no
    silent takedown: nobody can hide or erase a live block's ad
    without out-buying or out-burning its owner.

================================================================================

5. BANNER STUDIO  (Banner.exe)

    Every owner can create a banner WITHOUT uploading an image — a brand
    name + font + animated neon colors + link is enough. Uploaded images
    are auto-optimized (cover-cropped and resized to the exact block
    dimensions). Banners can be downloaded as PNG or placed directly
    onto a purchased area.

================================================================================

6. PIXEL HIJACK  (BURN-TO-CONQUER)

    An owned block can be overtaken by BURNING $PIXEL98. The BASE cost is
    a percentage of TOTAL SUPPLY (1,000,000,000 fixed), and that
    percentage drops as more of the supply is removed from circulation:

        cumulative burned < 25%   ->  1.00%  (10,000,000 $PIXEL98 base)
        cumulative burned >= 25%  ->  0.50%  ( 5,000,000 $PIXEL98 base)
        cumulative burned >= 50%  ->  0.25%  ( 2,500,000 $PIXEL98 base)
        cumulative burned >= 75%  ->  0.10%  ( 1,000,000 $PIXEL98 base)

    That base cost then SCALES WITH THE TARGET'S LIVE VALUATION (section
    7): a block worth more than the 0.2 SOL reference price costs
    proportionally MORE $PIXEL98 to hijack, and a block whose valuation
    has decayed costs proportionally LESS.

        hijack_cost = base_cost * (valuation / 0.2 SOL)

    The ratio is capped at 20x — so an extreme valuation never demands an
    unreasonable share of supply — and the final cost is always floored
    at 1 $PIXEL98: hijacking is never free.

    The hijack payment is split 50/50: half is burned forever and the
    other half is sent to the hijacked block's current owner (fair
    compensation for losing the ad).

    Each successful hijack REDUCES the target's valuation by 5% (0.95x).
    Hijack resets the ad and transfers ownership. (Activated at launch.)

    COOLDOWN: a block cannot be hijacked again for 24 hours after it last
    changed hands (a first sale, a "Buy at Valuation" purchase, or a
    hijack). Every new owner is guaranteed at least a day of real ad
    time before the spot is contestable again — without this, a
    well-funded attacker could re-hijack the same high-value spot the
    moment it's bought back.

================================================================================

7. VALUATION & BUY-AT-VALUATION  (THE FULL CYCLE)

    Every block carries a live VALUATION, denominated in SOL. It starts
    at the price the block was first bought for, and moves only two
    ways:

        - a PURCHASE (the first sale, or a "Buy at Valuation" below)
          raises it 10%           valuation_new = valuation * 1.10
        - a successful HIJACK (section 6) lowers it 5%
                                   valuation_new = valuation * 0.95

    At any time, ANYONE can buy an owned block outright — no listing
    required from the owner — through "Buy at Valuation": the buyer
    pays the block's current valuation, in SOL, directly to its current
    owner. The instant that purchase confirms, the valuation rises 10%,
    exactly as it would from a fresh sale.

    Example: a block is bought for 0.2000 SOL (valuation 0.2000 SOL).
    A hijack follows: valuation falls to 0.1900 SOL (x0.95), and the
    $PIXEL98 hijack cost for that attempt was itself priced off the
    0.2000 SOL valuation that was live at the time. The next buyer pays
    0.1900 SOL — not the original 0.2000 — and once that purchase
    confirms, the valuation rises to 0.2090 SOL (x1.10). If it's
    hijacked again, it falls to 0.19855 SOL, and so on: buy raises it
    10%, hijack lowers it 5%, indefinitely, for every block on the
    board.

================================================================================

8. PAYMENTS  (SOL + $PIXEL98)

    - SOL: a real SystemProgram.transfer to the treasury.
    - $PIXEL98: listings can also be priced in $PIXEL98 (1 SOL =
      100,000 $PIXEL98 reference rate); $PIXEL98 payments activate at
      launch.

    Ownership is tied to the buyer's wallet: a block is purchased with
    a real, wallet-signed SOL transfer (SystemProgram.transfer to the
    treasury), and the board records the paying wallet as the owner.

================================================================================

9. AIRDROP RULES

    At launch, tokens are airdropped to block owners proportional to
    block count:

        airdrop(owner) = (blocks_owned / blocks_sold) * total_supply

    (reference estimate: 100,000 $PIXEL98 per block)

================================================================================

10. TRANSPARENCY  (WHAT'S ACTUALLY ON-CHAIN)

    Every SOL payment on SOL-98 is a real, wallet-signed Solana
    transaction: a first sale or "Buy at Valuation" purchase sends SOL
    directly from the buyer (to the treasury for a first sale, to the
    current owner for Buy at Valuation), and — once $PIXEL98 is live
    post-launch — a hijack's burn is split on-chain, half destroyed
    and half sent to the previous owner. Every one of these transfers
    is independently checkable on any Solana explorer; nobody has to
    take SOL-98's word for a payment happening.

    What is NOT an on-chain program or NFT: which wallet currently
    owns a block, its ad content (link, image, tooltip, neon
    template), and its live valuation are tracked in SOL-98's own
    database, checked against the real on-chain payment at the moment
    of each purchase or hijack. This keeps editing an ad or reacting
    to a hijack instant and gas-free — but it means the board's
    CURRENT state is served by SOL-98, not read directly off an
    on-chain account. A public on-chain indexer (Roadmap, Phase 3) is
    planned so the board becomes independently verifiable without
    trusting the server for anything beyond "what does this wallet
    currently show as owning."

    Treasury wallet (receives first-sale proceeds):

        82gZCS4Tkwt2PXCrkLBYS9PY98es1xAivmhCj6Q1QjnL

    Every SOL that has ever moved in or out of this address is public
    on Solana — check it on Solscan or any Solana explorer before
    buying if you want to verify activity yourself.

================================================================================

NOTE: The token ($PIXEL98) launches on Pump.fun at the 100th sale.
Nothing in this document is financial advice.
`;

export function Whitepaper() {
  return <div className="win98-notepad h-full">{WHITEPAPER}</div>;
}
