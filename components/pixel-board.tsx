"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { usePixels } from "@/lib/pixel-store";
import { formatSol, TOTAL_SPOTS } from "@/lib/pricing";
import { LAUNCH_TARGET_SPOTS } from "@/lib/token";
import { PixelCell } from "./pixel-cell";
import { PixelDialog } from "./pixel-dialog";

/**
 * The pixel board — rendered directly on the green desktop (not in a window),
 * sized to fit the whole page. 100×100 blocks (10,000 spots), each a 10×10 px
 * area = a 1000×1000 px canvas (1,000,000 pixels). Minimum purchase 10×10,
 * 0.2 SOL, +10% per sale, launch countdown at the 100th sale.
 */
export function PixelBoard() {
  const { pixels, soldCount, nextPriceSol, totalRaisedSol, firstFreeIndex, syncState } =
    usePixels();
  const { connected } = useWallet();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const cells = useMemo(() => {
    const list: React.ReactElement[] = [];
    for (let i = 0; i < TOTAL_SPOTS; i++) {
      list.push(<PixelCell key={i} index={i} pixel={pixels[i]} onInteract={setActiveIndex} />);
    }
    return list;
  }, [pixels]);

  const remaining = Math.max(0, LAUNCH_TARGET_SPOTS - soldCount);
  const launchPct = Math.min(100, (soldCount / LAUNCH_TARGET_SPOTS) * 100);

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="win98-button"
          disabled={!connected || firstFreeIndex < 0}
          onClick={() => setActiveIndex(firstFreeIndex)}
        >
          Buy Pixel
        </button>
        <span className="text-xs text-white">
          Next block: <b>{formatSol(nextPriceSol)} SOL</b>
          <span className="text-white/60"> (min 10×10 · +10% per sale)</span>
        </span>
        {!connected && (
          <span className="text-[11px] text-yellow-200">Connect wallet to buy</span>
        )}
      </div>

      {/* Launch countdown — the 100th sale triggers the Pump.fun launch */}
      <div className="bevel-in flex items-center gap-2 px-2 py-1 text-xs">
        <span>Launch countdown:</span>
        <span>
          <b>{remaining}</b> / {LAUNCH_TARGET_SPOTS} blocks remaining
        </span>
        <div className="bevel-in ml-2 h-4 flex-1 bg-white">
          <div className="h-full bg-[#000080]" style={{ width: `${launchPct}%` }} />
        </div>
      </div>

      {/* Board — fills the page */}
      <div className="flex flex-1 justify-center overflow-auto">
        <div className="bevel-in" style={{ width: "min(100%, calc(100dvh - 190px))" }}>
          <div className="pixel-board-grid">{cells}</div>
        </div>
      </div>

      {/* Status */}
      <div className="bevel-in flex flex-wrap items-center gap-4 px-2 py-1 text-xs">
        <span>
          Blocks sold: <b>{soldCount}</b> / {TOTAL_SPOTS}
        </span>
        <span>100×100 · 10,000 blocks · 1,000,000 px</span>
        <span>
          Raised: <b>{formatSol(totalRaisedSol)} SOL</b>
        </span>
        <span className="text-[#808080]">
          {syncState === "live" ? "LIVE" : syncState === "offline" ? "OFFLINE" : "syncing…"}
        </span>
      </div>

      {activeIndex !== null && (
        <PixelDialog index={activeIndex} onClose={() => setActiveIndex(null)} />
      )}
    </div>
  );
}
