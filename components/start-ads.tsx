"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { FolderOpen, Plus, X } from "lucide-react";

import { useBoards, type ListingCurrency } from "@/lib/board-store";
import {
  BOARD_FILE_SIZE,
  BOARD_FILE_BLOCKS,
  type BoardFile,
  type BoardPixel,
} from "@/lib/board-types";
import { formatSol } from "@/lib/pricing";
import { isTokenLive, shortenAddress } from "@/lib/solana";
import { TOKEN_SYMBOL } from "@/lib/token";
import { friendlyIntentError } from "@/lib/purchase-intent";
import type { NeonTemplate } from "@/lib/pixel-types";
import { IntentCountdown } from "./intent-countdown";
import { Win98Alert } from "./win98-alert";

const NEON_OPTIONS: { value: NeonTemplate; label: string }[] = [
  { value: "none", label: "None" },
  { value: "cyberpunk-pulse", label: "Cyberpunk" },
  { value: "matrix", label: "Matrix" },
  { value: "flashing", label: "Flashing" },
  { value: "rainbow", label: "Rainbow" },
  { value: "sequential", label: "Sequential" },
];

/**
 * Start Ads — the flyout listing sellable board.exe files. Each file is a
 * 10×10 mini board (100 ad blocks) that its owner can fill with ads, rename,
 * and sell/rent block-by-block; others can hijack or buy/rent listed blocks.
 */
export function StartAdsMenu({ onClose }: { onClose: () => void }) {
  const { files, nextFilePriceSol } = useBoards();
  const [buyOpen, setBuyOpen] = useState(false);
  const [viewer, setViewer] = useState<BoardFile | null>(null);

  return (
    <>
      <div className="win98-menu-item font-bold">Start Ads</div>
      <div className="win98-menu-separator" />
      {files.length === 0 && (
        <div className="px-3 py-2 text-[11px] leading-snug text-[#808080]">
          No board.exe files yet. Buy the first one below.
        </div>
      )}
      {files.map((f) => (
        <button
          key={f.id}
          type="button"
          className="win98-menu-item w-full text-left"
          onClick={() => {
            setViewer(f);
            onClose();
          }}
        >
          <FolderOpen size={14} color="#f0b000" />
          <span className="flex-1 truncate">{f.name}</span>
        </button>
      ))}
      <div className="win98-menu-separator" />
      <button type="button" className="win98-menu-item w-full text-left" onClick={() => setBuyOpen(true)}>
        <Plus size={14} />
        <span className="flex-1">Buy board.exe</span>
        <span className="text-[10px]">{formatSol(nextFilePriceSol)} SOL</span>
      </button>

      {buyOpen && <BuyBoardDialog onClose={() => setBuyOpen(false)} />}
      {viewer && <BoardViewer file={viewer} onClose={() => setViewer(null)} />}
    </>
  );
}

function BuyBoardDialog({ onClose }: { onClose: () => void }) {
  const { nextFilePriceSol, buyBoard } = useBoards();
  const { connected } = useWallet();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<{ kind: "success" | "error"; title: string; message: string } | null>(null);

  async function handleBuy() {
    if (!connected) {
      setAlert({ kind: "error", title: "Wallet", message: "Connect your wallet first (top bar)." });
      return;
    }
    setBusy(true);
    try {
      await buyBoard(name.trim() || "Board.exe");
      setAlert({ kind: "success", title: "Purchased", message: "Your board.exe is yours — open it from Start Ads to place ads and sell blocks." });
    } catch (e) {
      setAlert({ kind: "error", title: "Purchase Failed", message: e instanceof Error ? e.message : "Transaction failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/25 p-3">
      <div className="win98-window bevel-out w-[360px]">
        <div className="win98-titlebar">
          <span className="flex-1 truncate text-[12px]">Buy board.exe</span>
          <button type="button" className="win98-title-button" onClick={onClose} aria-label="Close">
            <X size={9} strokeWidth={3} />
          </button>
        </div>
        <div className="flex flex-col gap-2 p-3">
          <div className="bevel-in px-2 py-1 text-xs">
            Price: <b>{formatSol(nextFilePriceSol)} SOL</b>
            <span className="text-[#808080]"> (+10% each sale)</span>
          </div>
          <label className="text-xs" htmlFor="board-name">Board name</label>
          <input id="board-name" className="win98-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Ad Board" />
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" className="win98-button" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="win98-button" onClick={handleBuy} disabled={busy}>
              {busy ? "Confirming…" : "Buy"}
            </button>
          </div>
        </div>
        {alert && (
          <Win98Alert kind={alert.kind} title={alert.title} message={alert.message} onOk={() => { if (alert.kind === "success") onClose(); setAlert(null); }} />
        )}
      </div>
    </div>
  );
}

function BoardViewer({ file, onClose }: { file: BoardFile; onClose: () => void }) {
  const { pixels, renameBoard } = useBoards();
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58() ?? "";
  const isOwner = file.owner === me;

  const [selected, setSelected] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(file.name);
  const [alert, setAlert] = useState<{ kind: "success" | "error"; title: string; message: string } | null>(null);

  const blocks: (BoardPixel | undefined)[] = Array.from({ length: BOARD_FILE_BLOCKS }, (_, i) => pixels[`${file.id}:${i}`]);

  async function handleRename() {
    try {
      await renameBoard(file.id, newName.trim() || file.name);
      setRenaming(false);
    } catch (e) {
      setAlert({ kind: "error", title: "Rename Failed", message: e instanceof Error ? e.message : "Could not rename" });
    }
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/25 p-3">
      <div className="win98-window bevel-out w-[420px]">
        <div className="win98-titlebar">
          <span className="flex-1 truncate text-[12px]">{file.name} — board.exe</span>
          <button type="button" className="win98-title-button" onClick={onClose} aria-label="Close">
            <X size={9} strokeWidth={3} />
          </button>
        </div>

        <div className="flex max-h-[70vh] flex-col gap-2 overflow-auto p-3">
          <div className="bevel-in px-2 py-1 text-[11px] text-[#808080]">
            Owner: {shortenAddress(file.owner, 6)} · 10×10 = {BOARD_FILE_BLOCKS} blocks
          </div>

          {isOwner && (
            <div className="flex items-center gap-2">
              {renaming ? (
                <>
                  <input className="win98-field" value={newName} onChange={(e) => setNewName(e.target.value)} />
                  <button type="button" className="win98-button" onClick={handleRename}>Save</button>
                  <button type="button" className="win98-button" onClick={() => setRenaming(false)}>Cancel</button>
                </>
              ) : (
                <button type="button" className="win98-button" onClick={() => setRenaming(true)}>Rename</button>
              )}
              <span className="text-[11px] text-[#808080]">You own this board — click a block to place an ad or list it.</span>
            </div>
          )}

          <div className="grid grid-cols-10 gap-[1px] bg-[#808080] p-[1px]">
            {blocks.map((b, i) => {
              const mine = b?.owner === me;
              const listed = b?.listingPriceSol !== undefined || b?.rentPriceSol !== undefined;
              return (
                <button
                  key={i}
                  type="button"
                  className="aspect-square bg-white"
                  style={{
                    background: mine ? "#9ccf9c" : b?.owner ? "#d0d0d0" : "#ffffff",
                    outline: listed ? "2px solid #c00000" : undefined,
                  }}
                  onClick={() => setSelected(i)}
                  title={`Block ${i + 1}${b?.owner ? ` — ${shortenAddress(b.owner, 4)}` : ""}`}
                />
              );
            })}
          </div>
        </div>

        {alert && <Win98Alert kind={alert.kind} title={alert.title} message={alert.message} onOk={() => setAlert(null)} />}
        {selected !== null && <SubBlockDialog boardId={file.id} index={selected} pixel={blocks[selected]} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

function SubBlockDialog({
  boardId,
  index,
  pixel,
  onClose,
}: {
  boardId: string;
  index: number;
  pixel: BoardPixel | undefined;
  onClose: () => void;
}) {
  const { editPixel, listForSale, listForRent, unlist, buyListing, rentPixel, hijackPixel, hijackCostTokens, hijackSplit, activeIntent, txPhase } =
    useBoards();
  const { publicKey, connected } = useWallet();
  const me = publicKey?.toBase58() ?? "";

  const [destination, setDestination] = useState(pixel?.destination ?? "");
  const [message, setMessage] = useState(pixel?.message ?? "");
  const [neon, setNeon] = useState<NeonTemplate>(pixel?.neon ?? "none");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState<ListingCurrency>("SOL");
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<{ kind: "success" | "error"; title: string; message: string } | null>(null);

  const isOwner = pixel?.owner === me;
  const listed = pixel?.listingPriceSol !== undefined || pixel?.rentPriceSol !== undefined;

  function showErr(e: unknown) {
    // SOL-98 Phase 4 (GÖREV 1) — buyListing/rentPixel/hijackPixel now all
    // reserve a purchase intent before paying (see lib/board-store.tsx); a
    // 410/403/409 here is mapped to a message the user can act on instead
    // of the raw HTTP error. Other actions (editPixel/listForSale/
    // listForRent/unlist) don't go through the intent system, but
    // friendlyIntentError safely falls back to the original message for
    // those too.
    setAlert({ kind: "error", title: "Failed", message: friendlyIntentError(e) });
  }

  async function run(fn: () => Promise<unknown>, successMsg: string) {
    if (!connected) {
      setAlert({ kind: "error", title: "Wallet", message: "Connect your wallet first." });
      return;
    }
    setBusy(true);
    try {
      await fn();
      setAlert({ kind: "success", title: "Done", message: successMsg });
    } catch (e) {
      showErr(e);
    } finally {
      setBusy(false);
    }
  }

  const p = parseFloat(price);

  return (
    <div className="fixed inset-0 z-[310] flex items-center justify-center bg-black/30 p-3">
      <div className="win98-window bevel-out w-[340px]">
        <div className="win98-titlebar">
          <span className="flex-1 truncate text-[12px]">Block #{index + 1}</span>
          <button type="button" className="win98-title-button" onClick={onClose} aria-label="Close">
            <X size={9} strokeWidth={3} />
          </button>
        </div>
        <div className="flex max-h-[70vh] flex-col gap-2 overflow-auto p-3">
          <div className="bevel-in px-2 py-1 text-[11px] text-[#808080]">
            {pixel?.owner ? `Owner: ${shortenAddress(pixel.owner, 6)}` : "Unclaimed"} · Valuation: {formatSol(pixel?.valuationSol ?? 0.2)} SOL
          </div>

          {isOwner && (
            <>
              <label className="text-xs" htmlFor="sb-dest">Ad link (http/https)</label>
              <input id="sb-dest" className="win98-field" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="https://your-site.com" />
              <label className="text-xs" htmlFor="sb-msg">Message</label>
              <input id="sb-msg" className="win98-field" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Your ad text" maxLength={200} />
              <div className="flex flex-wrap gap-1">
                {NEON_OPTIONS.map((o) => (
                  <button key={o.value} type="button" className="win98-button flex-1 !px-1 !py-0 text-[10px]" style={neon === o.value ? { background: "#000080", color: "#fff" } : undefined} onClick={() => setNeon(o.value)}>
                    {o.label}
                  </button>
                ))}
              </div>
              <button type="button" className="win98-button" disabled={busy} onClick={() => run(() => editPixel(boardId, index, { destination: destination.trim(), message: message.trim(), neon }), "Ad placed.")}>
                {busy ? "Saving…" : "Place Ad"}
              </button>

              <div className="win98-menu-separator" />
              <label className="text-xs" htmlFor="sb-price">List for sale ({currency === "SOL" ? "SOL" : "$PIXEL98"})</label>
              <div className="flex gap-1">
                <input id="sb-price" className="win98-field" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="1.5" />
                <select className="win98-field !w-auto" value={currency} onChange={(e) => setCurrency(e.target.value as ListingCurrency)}>
                  <option value="SOL">SOL</option>
                  <option value="PIXEL98">$PIXEL98</option>
                </select>
                <button type="button" className="win98-button" disabled={busy || !Number.isFinite(p) || p <= 0} onClick={() => run(() => listForSale(boardId, index, p, currency), "Listed for sale.")}>Sell</button>
              </div>
              <button type="button" className="win98-button" disabled={busy || !Number.isFinite(p) || p <= 0} onClick={() => run(() => listForRent(boardId, index, p, currency), "Listed for rent.")}>
                List for rent ({currency === "SOL" ? "SOL" : "$PIXEL98"}/day)
              </button>
              {listed && <button type="button" className="win98-button" disabled={busy} onClick={() => run(() => unlist(boardId, index), "Unlisted.")}>Unlist</button>}
            </>
          )}

          {!isOwner && (
            <>
              {/* SOL-98 Phase 4 (GÖREV 3) — live cost estimate, driven off
                  the polled burnedFraction. hijackPixel() (lib/board-store.tsx)
                  reserves a purchase intent first, which does NOT lock this
                  number in (Phase 3 decision — burnedFraction moves
                  continuously); it's recomputed fresh again right before the
                  wallet is asked to sign, so this is a live estimate, not a
                  stale/cached figure. */}
              {isTokenLive() && (
                <div className="text-[11px] text-[#808080]">
                  {busy ? "Locking in current price…" : `Est. cost: ${hijackCostTokens} ${TOKEN_SYMBOL}`}
                  {" "}({hijackSplit.burnedTokens} burned · {hijackSplit.ownerTokens} to owner)
                </div>
              )}
              <button type="button" className="win98-button" disabled={busy} onClick={() => run(() => hijackPixel(boardId, index), "Hijacked — valuation −5%.")}>
                {busy
                  ? txPhase === "creating_intent"
                    ? "Locking price…"
                    : txPhase === "awaiting_signature"
                      ? isTokenLive()
                        ? "Confirm burn…"
                        : "Confirm signature…"
                      : "Hijacking…"
                  : isTokenLive()
                    ? "Hijack (burn)"
                    : "Hijack (simulated, free)"}
              </button>
              {isTokenLive() && activeIntent?.actionType === "hijack" && (
                <IntentCountdown expiresAt={activeIntent.expiresAt} />
              )}
              {!isTokenLive() && (
                <div className="text-[11px] text-[#808080]">
                  $PIXEL98 not live yet — free, wallet-signed, rate-limited simulated hijack. Real burns activate after launch.
                </div>
              )}
              {pixel?.listingPriceSol !== undefined && (
                <button type="button" className="win98-button" disabled={busy} onClick={() => run(() => buyListing(boardId, index), "Purchased.")}>
                  {busy && (activeIntent?.actionType === "buy-listing" || txPhase === "creating_intent")
                    ? txPhase === "creating_intent"
                      ? "Locking price…"
                      : "Confirm in wallet…"
                    : `Buy — ${formatSol(pixel.listingPriceSol)} SOL`}
                </button>
              )}
              {pixel?.rentPriceSol !== undefined && (
                <button type="button" className="win98-button" disabled={busy} onClick={() => run(() => rentPixel(boardId, index, 30), "Rented 30 days.")}>
                  {busy && (activeIntent?.actionType === "rent" || txPhase === "creating_intent")
                    ? txPhase === "creating_intent"
                      ? "Locking price…"
                      : "Confirm in wallet…"
                    : `Rent 30d — ${formatSol(pixel.rentPriceSol)} SOL/day`}
                </button>
              )}
              {activeIntent && (activeIntent.actionType === "buy-listing" || activeIntent.actionType === "rent") && (
                <IntentCountdown expiresAt={activeIntent.expiresAt} />
              )}
              {pixel?.listingPricePixel98 !== undefined && <div className="text-[11px] text-[#808080]">Listed @ {pixel.listingPricePixel98} $PIXEL98 (after launch)</div>}
              {pixel?.rentPricePixel98 !== undefined && <div className="text-[11px] text-[#808080]">Rent {pixel.rentPricePixel98} $PIXEL98/day (after launch)</div>}
            </>
          )}
        </div>

        {alert && <Win98Alert kind={alert.kind} title={alert.title} message={alert.message} onOk={() => { if (alert.kind === "success") onClose(); setAlert(null); }} />}
      </div>
    </div>
  );
}
