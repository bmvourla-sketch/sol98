"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { X } from "lucide-react";

import { usePixels, type NeonTemplate } from "@/lib/pixel-store";
import { areaPrice, BOARD_SIZE, formatSol } from "@/lib/pricing";
import { hijackCostInTokens, TOKEN_SYMBOL } from "@/lib/token";
import { isTokenLive, shortenAddress } from "@/lib/solana";
import { useBurnPixel98, useSendSolTransfer } from "@/lib/use-solana-tx";
import { Win98Alert } from "./win98-alert";

interface PixelDialogProps {
  indices: number[];
  onClose: () => void;
}

type TxStatus = "idle" | "awaiting_signature" | "processing" | "success" | "failed";

const NEON_OPTIONS: { value: NeonTemplate; label: string }[] = [
  { value: "none", label: "None" },
  { value: "cyberpunk-pulse", label: "Cyberpunk Pulse" },
  { value: "matrix", label: "Matrix Text" },
  { value: "flashing", label: "Flashing Neon Border" },
  { value: "glitch", label: "Sub-Domain Glitch" },
];

const NEON_PREVIEW_CLASS: Partial<Record<NeonTemplate, string>> = {
  "cyberpunk-pulse": "neon-cyberpunk-pulse",
  matrix: "neon-matrix",
  flashing: "neon-flashing",
  glitch: "neon-glitch",
};

interface AlertState {
  kind: "success" | "error";
  title: string;
  message: string;
}

/**
 * One dialog. Single block → buy / hijack / manage. Multi-block selection →
 * "Buy Area": one banner spanning the rectangle, price scales with area.
 */
export function PixelDialog({ indices, onClose }: PixelDialogProps) {
  const { publicKey, connected } = useWallet();
  const sendSol = useSendSolTransfer();
  const burnPixel98 = useBurnPixel98();
  const {
    pixels,
    soldCount,
    nextPriceSol,
    pixel98Balance,
    buyPixel,
    buyArea,
    hijackPixel,
    spendPixel98,
    editPixel,
    listForSale,
    unlist,
  } = usePixels();

  const index = indices[0];
  const multi = indices.length > 1;
  const pixel = multi ? undefined : pixels[index];
  const owner = publicKey?.toBase58() ?? "";

  const [destination, setDestination] = useState(pixel?.destination ?? "");
  const [imageUrl, setImageUrl] = useState(pixel?.imageUrl ?? "");
  const [message, setMessage] = useState(pixel?.message ?? "");
  const [neon, setNeon] = useState<NeonTemplate>(pixel?.neon ?? "none");
  const [sellPrice, setSellPrice] = useState("");
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [alert, setAlert] = useState<AlertState | null>(null);

  const tokenLive = isTokenLive();
  const mode: "buy" | "hijack" | "manage" = multi
    ? "buy"
    : !pixel
      ? "buy"
      : pixel.owner === owner
        ? "manage"
        : "hijack";
  const hijackCost = pixel ? hijackCostInTokens(pixel.valuationSol) : 0;
  const busy = txStatus === "awaiting_signature" || txStatus === "processing";
  const price = multi ? areaPrice(soldCount, indices.length) : nextPriceSol;

  const areaCols = Math.max(...indices.map((i) => i % BOARD_SIZE)) - Math.min(...indices.map((i) => i % BOARD_SIZE)) + 1;
  const areaRows =
    Math.max(...indices.map((i) => Math.floor(i / BOARD_SIZE))) -
    Math.min(...indices.map((i) => Math.floor(i / BOARD_SIZE))) +
    1;

  const title = multi
    ? `Buy Area — ${areaCols}×${areaRows} (${indices.length} blocks)`
    : mode === "buy"
      ? `Buy Pixel #${index + 1}`
      : mode === "hijack"
        ? `Hijack.exe — Pixel #${index + 1}`
        : `Manage Pixel #${index + 1}`;

  function showError(title: string, msg: string) {
    setTxStatus("failed");
    setAlert({ kind: "error", title, message: msg });
  }

  async function handleBuy() {
    if (!connected || !publicKey) {
      setAlert({ kind: "error", title: "Wallet", message: "Connect your wallet first (top-right)." });
      return;
    }
    setTxStatus("awaiting_signature");
    try {
      const signature = await sendSol(price, () => setTxStatus("processing"));
      setTxStatus("success");
      const ad = {
        destination: destination.trim(),
        imageUrl: imageUrl.trim(),
        message: message.trim(),
        neon,
      };
      if (multi) buyArea(indices, owner, ad, soldCount);
      else buyPixel(index, owner, ad);
      setAlert({
        kind: "success",
        title: multi ? "Area Purchased" : "Purchase Complete",
        message: `${multi ? `${indices.length} blocks` : `Pixel #${index + 1}`} is yours.\n\nTx: ${signature}`,
      });
    } catch (error) {
      showError("Transaction Failed", error instanceof Error ? error.message : "Transaction failed");
    }
  }

  async function handleHijack() {
    if (!tokenLive) {
      setAlert({ kind: "error", title: "Coming Soon", message: "Hijack activates after the $PIXEL98 Pump.fun launch." });
      return;
    }
    if (!connected || !publicKey) {
      setAlert({ kind: "error", title: "Wallet", message: "Connect your wallet first (top-right)." });
      return;
    }
    setTxStatus("awaiting_signature");
    try {
      const outcome = await burnPixel98(hijackCost, () => setTxStatus("processing"));
      if (outcome.simulated) {
        if (!spendPixel98(hijackCost)) {
          showError("Hijack Failed", `Not enough ${TOKEN_SYMBOL} to hijack.`);
          return;
        }
      }
      const ok = hijackPixel(index, owner);
      if (!ok) {
        showError("Hijack Failed", "Spot is no longer available.");
        return;
      }
      setTxStatus("success");
      setAlert({
        kind: "success",
        title: "Hijack Complete",
        message: `Pixel #${index + 1} is now yours.\nValuation −5% applied.${
          outcome.simulated
            ? `\n\nBurn: SIMULATED (${TOKEN_SYMBOL} not live yet)`
            : `\n\nBurn tx: ${outcome.signature}`
        }`,
      });
    } catch (error) {
      showError("Hijack Failed", error instanceof Error ? error.message : "Hijack failed");
    }
  }

  function handleEdit() {
    editPixel(index, {
      destination: destination.trim(),
      imageUrl: imageUrl.trim(),
      message: message.trim(),
      neon,
    });
    onClose();
  }

  function handleListForSale() {
    const price = parseFloat(sellPrice);
    if (!Number.isFinite(price) || price <= 0) {
      setAlert({ kind: "error", title: "Invalid Price", message: "Enter a valid SOL price." });
      return;
    }
    listForSale(index, price);
    onClose();
  }

  const neonPreviewClass = NEON_PREVIEW_CLASS[neon] ?? "";

  return (
    <div className="absolute inset-0 z-[200] flex items-center justify-center bg-black/25 p-3">
      <div className="win98-window bevel-out w-[360px]">
        <div className="win98-titlebar">
          <span className="flex-1 truncate text-[12px]">{title}</span>
          <button type="button" className="win98-title-button" onClick={onClose} aria-label="Close">
            <X size={9} strokeWidth={3} />
          </button>
        </div>

        <div className="flex max-h-[72vh] flex-col gap-2 overflow-auto p-3">
          {mode === "buy" && (
            <div className="bevel-in px-2 py-1 text-xs">
              {multi ? (
                <span>
                  Area: {areaCols}×{areaRows} = {indices.length} blocks · first @{" "}
                  {formatSol(nextPriceSol)}, +10% each ·{" "}
                </span>
              ) : (
                <span>Single block (10×10 px) · </span>
              )}
              Total: <b>{formatSol(price)} SOL</b>
              <span className="text-[#808080]"> (bonding curve)</span>
            </div>
          )}

          {mode === "hijack" && pixel && (
            <div className="bevel-in flex flex-col gap-1 px-2 py-1 text-xs">
              <span>Owner: <b>{shortenAddress(pixel.owner, 6)}</b></span>
              <span>Valuation: <b>{formatSol(pixel.valuationSol)} SOL</b></span>
              <span>Burn: <b>{hijackCost} {TOKEN_SYMBOL}</b> <span className="text-[#808080]">(balance: {pixel98Balance})</span></span>
              <span className="text-[#808080]">Hijack → valuation −5%</span>
              {!tokenLive && <span className="text-[#800000]">Coming Soon — $PIXEL98 not live yet</span>}
            </div>
          )}

          {(mode === "buy" || mode === "manage") && (
            <>
              <div className="bevel-in flex h-12 items-center justify-center overflow-hidden bg-black p-2">
                {imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={imageUrl} alt="Ad preview" className={`max-h-full max-w-full object-contain ${neonPreviewClass}`} />
                ) : (
                  <span className={`text-sm font-bold ${neonPreviewClass || "text-white"}`}>
                    {message.trim() || "YOUR AD HERE"}
                  </span>
                )}
              </div>

              <label className="text-xs" htmlFor="pix-dest">Destination Link</label>
              <input id="pix-dest" className="win98-field" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="https://your-site.com" />
              <label className="text-xs" htmlFor="pix-img">Image / GIF URL</label>
              <input id="pix-img" className="win98-field" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://.../banner.gif" />
              <label className="text-xs" htmlFor="pix-msg">Tooltip Message</label>
              <input id="pix-msg" className="win98-field" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="gm" />
              <label className="text-xs">Neon Banner</label>
              <div className="flex flex-wrap gap-1">
                {NEON_OPTIONS.map((opt) => (
                  <button key={opt.value} type="button" className="win98-button flex-1 !px-1 !py-1 text-[11px]" style={neon === opt.value ? { background: "#000080", color: "#fff" } : undefined} onClick={() => setNeon(opt.value)}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </>
          )}

          {mode === "manage" && pixel && (
            <>
              <div className="win98-menu-separator" />
              <label className="text-xs" htmlFor="pix-sell">List for Sale (SOL)</label>
              <div className="flex gap-1">
                <input id="pix-sell" className="win98-field" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} placeholder="e.g. 1.5" />
                <button type="button" className="win98-button" onClick={handleListForSale}>Sell</button>
              </div>
              {pixel.listingPriceSol !== undefined && (
                <button type="button" className="win98-button" onClick={() => { unlist(index); onClose(); }}>Unlist</button>
              )}
            </>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <button type="button" className="win98-button" onClick={onClose} disabled={busy}>Cancel</button>
            {mode === "buy" && (
              <button type="button" className="win98-button" onClick={handleBuy} disabled={busy}>
                {txStatus === "awaiting_signature" ? "Confirm in wallet…" : txStatus === "processing" ? "Confirming…" : `Buy (${formatSol(price)} SOL)`}
              </button>
            )}
            {mode === "hijack" && (
              <button type="button" className="win98-button" onClick={handleHijack} disabled={busy || !tokenLive}>
                {!tokenLive ? "Coming Soon" : txStatus === "awaiting_signature" ? "Confirm burn…" : txStatus === "processing" ? "Burning…" : `Hijack (${hijackCost})`}
              </button>
            )}
            {mode === "manage" && (
              <button type="button" className="win98-button" onClick={handleEdit}>Save</button>
            )}
          </div>
        </div>

        {alert && (
          <Win98Alert
            kind={alert.kind}
            title={alert.title}
            message={alert.message}
            onOk={() => {
              setAlert(null);
              if (txStatus === "success") onClose();
              else setTxStatus("idle");
            }}
          />
        )}
      </div>
    </div>
  );
}
