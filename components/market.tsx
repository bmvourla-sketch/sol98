"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { usePixels } from "@/lib/pixel-store";
import { formatSol } from "@/lib/pricing";
import { TOKEN_SYMBOL } from "@/lib/token";
import { isTokenLive, shortenAddress } from "@/lib/solana";
import { PixelDialog } from "./pixel-dialog";

/**
 * Market.exe — buy, rent, or sell ad spots. Shows the mock $PIXEL98 balance
 * (with a test faucet), your owned spots, and the open listings for sale/rent.
 * All actions route through the mock transaction handler.
 */
export function Market() {
  const { publicKey, connected } = useWallet();
  const ctx = usePixels();
  const owner = publicKey?.toBase58() ?? "";
  const [dialogIndex, setDialogIndex] = useState<number | null>(null);

  const mySpots = Object.values(ctx.pixels).filter((p) => p.owner === owner);
  const forSale = Object.values(ctx.pixels).filter(
    (p) => p.listingPriceSol !== undefined && p.owner !== owner
  );
  const forRent = Object.values(ctx.pixels).filter(
    (p) => p.rentPriceSol !== undefined && p.owner !== owner
  );

  function buyListing(index: number) {
    if (!connected || !owner) return;
    ctx.buyListing(index, owner);
  }

  function rent(index: number) {
    if (!connected || !owner) return;
    ctx.rentPixel(index, owner, 30);
  }

  function listForRent(index: number) {
    ctx.listForRent(index, 0.05); // mock default 0.05 SOL/day
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto bg-[#c0c0c0] p-2 text-xs">
      {/* Token balance + faucet + airdrop (gated until Pump.fun launch) */}
      {isTokenLive() ? (
        <div className="bevel-in flex flex-wrap items-center gap-3 px-2 py-1">
          <span>
            {TOKEN_SYMBOL} balance: <b>{ctx.pixel98Balance}</b>
          </span>
          <button type="button" className="win98-button !px-2 !py-0" onClick={() => ctx.claimPixel98(10000)}>
            Claim 10,000 test {TOKEN_SYMBOL}
          </button>
          <span className="ml-auto text-[#808080]">
            Airdrop: {ctx.airdropForOwner(owner)} {TOKEN_SYMBOL} ({ctx.spotsOwnedBy(owner)} spots)
          </span>
        </div>
      ) : (
        <div className="bevel-in px-2 py-1 text-xs text-[#808080]">
          {TOKEN_SYMBOL} · Airdrop · Hijack — Coming Soon (Pump.fun launch)
        </div>
      )}

      {!connected && <div className="text-[#800000]">Connect wallet to use the market.</div>}

      {/* My spots */}
      <div className="bevel-out px-2 py-1 font-bold">My Spots ({mySpots.length})</div>
      {mySpots.length === 0 && <div className="px-1 text-[#808080]">No spots yet — buy one on Board.exe.</div>}
      {mySpots.map((p) => (
        <div key={p.index} className="bevel-out flex flex-wrap items-center gap-2 px-2 py-1">
          <span>#{p.index + 1}</span>
          <span className="text-[#808080]">{formatSol(p.valuationSol)} SOL</span>
          {p.listingPriceSol !== undefined && (
            <span className="text-[#800000]">listed @ {formatSol(p.listingPriceSol)} SOL</span>
          )}
          {p.rentPriceSol !== undefined && (
            <span className="text-[#000080]">rent {formatSol(p.rentPriceSol)}/day</span>
          )}
          <span className="ml-auto flex gap-1">
            <button type="button" className="win98-button !px-2 !py-0" onClick={() => setDialogIndex(p.index)}>
              Manage
            </button>
            {p.rentPriceSol === undefined && p.listingPriceSol === undefined && (
              <button type="button" className="win98-button !px-2 !py-0" onClick={() => listForRent(p.index)}>
                Rent out
              </button>
            )}
          </span>
        </div>
      ))}

      {/* For sale */}
      <div className="bevel-out px-2 py-1 font-bold">For Sale ({forSale.length})</div>
      {forSale.length === 0 && <div className="px-1 text-[#808080]">No listings.</div>}
      {forSale.map((p) => (
        <div key={p.index} className="bevel-out flex items-center gap-2 px-2 py-1">
          <span>#{p.index + 1}</span>
          <span className="text-[#808080]">{shortenAddress(p.owner, 4)}</span>
          <span>@ {formatSol(p.listingPriceSol ?? 0)} SOL</span>
          <button type="button" className="win98-button !px-2 !py-0 ml-auto" onClick={() => buyListing(p.index)}>
            Buy
          </button>
        </div>
      ))}

      {/* For rent */}
      <div className="bevel-out px-2 py-1 font-bold">For Rent ({forRent.length})</div>
      {forRent.length === 0 && <div className="px-1 text-[#808080]">No listings.</div>}
      {forRent.map((p) => (
        <div key={p.index} className="bevel-out flex items-center gap-2 px-2 py-1">
          <span>#{p.index + 1}</span>
          <span className="text-[#808080]">{shortenAddress(p.owner, 4)}</span>
          <span>{formatSol(p.rentPriceSol ?? 0)} SOL/day</span>
          <button type="button" className="win98-button !px-2 !py-0 ml-auto" onClick={() => rent(p.index)}>
            Rent 30d
          </button>
        </div>
      ))}

      {dialogIndex !== null && <PixelDialog indices={[dialogIndex]} onClose={() => setDialogIndex(null)} />}
    </div>
  );
}
