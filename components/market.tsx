"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { usePixels } from "@/lib/pixel-store";
import { formatSol } from "@/lib/pricing";
import { isTokenLive, shortenAddress } from "@/lib/solana";
import { friendlyIntentError } from "@/lib/purchase-intent";
import { IntentCountdown } from "./intent-countdown";
import { PixelDialog } from "./pixel-dialog";

/** SOL-98 Phase 4 (GÖREV 1) — busy-button label reflecting the current step
 * of the intent → sign → redeem flow. */
function buyBusyLabel(txPhase: "creating_intent" | "awaiting_signature" | "processing" | null): string {
  if (txPhase === "creating_intent") return "Locking price…";
  if (txPhase === "awaiting_signature") return "Confirm in wallet…";
  return "Paying…";
}

/**
 * Market.exe — buy, rent, or sell ad spots. "Buy"/"Rent" here send a REAL
 * peer-to-peer SOL payment straight to the current owner's wallet (not the
 * treasury) before the server transfers ownership/rental — there is no free
 * path through this screen.
 */
export function Market() {
  const { publicKey, connected } = useWallet();
  const ctx = usePixels();
  const owner = publicKey?.toBase58() ?? "";
  const [dialogIndex, setDialogIndex] = useState<number | null>(null);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mySpots = Object.values(ctx.pixels).filter((p) => p.owner === owner);
  const forSale = Object.values(ctx.pixels).filter(
    (p) => (p.listingPriceSol !== undefined || p.listingPricePixel98 !== undefined) && p.owner !== owner
  );
  const forRent = Object.values(ctx.pixels).filter(
    (p) => (p.rentPriceSol !== undefined || p.rentPricePixel98 !== undefined) && p.owner !== owner
  );

  async function buyListing(index: number) {
    if (!connected || !owner) return;
    setError(null);
    setBusyIndex(index);
    try {
      await ctx.buyListing(index);
    } catch (err) {
      // SOL-98 Phase 4 (GÖREV 1) — buyListing now reserves a purchase
      // intent before paying (see lib/pixel-store.tsx); a 410/403/409 here
      // means the offer expired, belonged to a different wallet, or the
      // listing changed before payment landed. friendlyIntentError maps
      // those to a message the user can act on instead of a raw HTTP error.
      setError(friendlyIntentError(err));
    } finally {
      setBusyIndex(null);
    }
  }

  async function rent(index: number) {
    if (!connected || !owner) return;
    setError(null);
    setBusyIndex(index);
    try {
      await ctx.rentPixel(index, 30);
    } catch (err) {
      setError(friendlyIntentError(err));
    } finally {
      setBusyIndex(null);
    }
  }

  async function listForRent(index: number) {
    setError(null);
    try {
      await ctx.listForRent(index, 0.05, "SOL"); // default 0.05 SOL/day — owner can relist at any price via Manage
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not list for rent");
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto bg-[#c0c0c0] p-2 text-xs">
      {/* Hijack / $PIXEL98 status (informational — nothing here is spendable) */}
      <div className="bevel-in flex flex-wrap items-center gap-3 px-2 py-1 text-[#808080]">
        {isTokenLive() ? (
          <span>
            $PIXEL98 is live — hijacks burn real tokens. Airdrop:{" "}
            <b>{ctx.airdropForOwner(owner)}</b> $PIXEL98 ({ctx.spotsOwnedBy(owner)} spots)
          </span>
        ) : (
          <span>$PIXEL98 · Airdrop · real Hijack burns — Coming Soon (Pump.fun launch)</span>
        )}
      </div>

      {!connected && <div className="text-[#800000]">Connect wallet to use the market.</div>}
      {error && <div className="bevel-in px-2 py-1 text-[#800000]">{error}</div>}
      {ctx.activeIntent && busyIndex !== null && (
        <div className="bevel-in px-2 py-1">
          <IntentCountdown expiresAt={ctx.activeIntent.expiresAt} />
        </div>
      )}

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
          {p.listingPricePixel98 !== undefined && (
            <span className="text-[#800000]">listed @ {p.listingPricePixel98} $PIXEL98</span>
          )}
          {p.rentPriceSol !== undefined && (
            <span className="text-[#000080]">rent {formatSol(p.rentPriceSol)}/day</span>
          )}
          {p.rentPricePixel98 !== undefined && (
            <span className="text-[#000080]">rent {p.rentPricePixel98} $PIXEL98/day</span>
          )}
          <span className="ml-auto flex gap-1">
            <button type="button" className="win98-button !px-2 !py-0" onClick={() => setDialogIndex(p.index)}>
              Manage
            </button>
            {p.rentPriceSol === undefined && p.listingPriceSol === undefined && p.rentPricePixel98 === undefined && p.listingPricePixel98 === undefined && (
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
          <span>
            {p.listingPriceSol !== undefined
              ? `@ ${formatSol(p.listingPriceSol)} SOL`
              : `@ ${p.listingPricePixel98} $PIXEL98`}
          </span>
          {p.listingPriceSol !== undefined ? (
            <button
              type="button"
              className="win98-button !px-2 !py-0 ml-auto"
              onClick={() => buyListing(p.index)}
              disabled={busyIndex === p.index}
            >
              {busyIndex === p.index ? buyBusyLabel(ctx.txPhase) : "Buy"}
            </button>
          ) : (
            <button type="button" className="win98-button !px-2 !py-0 ml-auto" disabled title="Available after $PIXEL98 launch">
              After launch
            </button>
          )}
        </div>
      ))}

      {/* For rent */}
      <div className="bevel-out px-2 py-1 font-bold">For Rent ({forRent.length})</div>
      {forRent.length === 0 && <div className="px-1 text-[#808080]">No listings.</div>}
      {forRent.map((p) => (
        <div key={p.index} className="bevel-out flex items-center gap-2 px-2 py-1">
          <span>#{p.index + 1}</span>
          <span className="text-[#808080]">{shortenAddress(p.owner, 4)}</span>
          <span>
            {p.rentPriceSol !== undefined
              ? `${formatSol(p.rentPriceSol)} SOL/day`
              : `${p.rentPricePixel98} $PIXEL98/day`}
          </span>
          {p.rentPriceSol !== undefined ? (
            <button
              type="button"
              className="win98-button !px-2 !py-0 ml-auto"
              onClick={() => rent(p.index)}
              disabled={busyIndex === p.index}
            >
              {busyIndex === p.index ? buyBusyLabel(ctx.txPhase) : "Rent 30d"}
            </button>
          ) : (
            <button type="button" className="win98-button !px-2 !py-0 ml-auto" disabled title="Available after $PIXEL98 launch">
              After launch
            </button>
          )}
        </div>
      ))}

      {dialogIndex !== null && <PixelDialog indices={[dialogIndex]} onClose={() => setDialogIndex(null)} />}
    </div>
  );
}
