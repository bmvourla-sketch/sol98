"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { usePixels } from "@/lib/pixel-store";
import { formatSol, TOTAL_SPOTS } from "@/lib/pricing";
import { LAUNCH_TARGET_SPOTS } from "@/lib/token";
import { PixelCell } from "./pixel-cell";
import { PixelDialog } from "./pixel-dialog";

/**
 * The pixel board — rendered directly on the green desktop (not in a window).
 * A 1000×1000 px canvas = 1,000,000 pixels, sold in 10×10 blocks (10,000
 * blocks). The desktop scrolls to reveal the full board.
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

  const launchPct = Math.min(100, (soldCount / LAUNCH_TARGET_SPOTS) * 100);

  return (
    <div className="flex flex-col gap-2 p-3">
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
          <span className="text-white/60"> (10×10 px)</span>
        </span>
        {!connected && (
          <span className="text-[11px] text-yellow-200">Connect wallet (top bar) to buy</span>
        )}
      </div>

      {/* Board (1000×1000 px) */}
      <div className="bevel-in w-max">
        <div className="pixel-board-grid">{cells}</div>
      </div>

      {/* Status bar */}
      <div className="bevel-in flex flex-wrap items-center gap-4 px-2 py-1 text-xs">
        <span>
          Blocks sold: <b>{soldCount}</b> / {TOTAL_SPOTS}
        </span>
        <span>1000×1000 px · 1,000,000 px</span>
        <span>
          Raised: <b>{formatSol(totalRaisedSol)} SOL</b>
        </span>
        <span className="text-[#808080]">
          {syncState === "live" ? "LIVE" : syncState === "offline" ? "OFFLINE" : "syncing…"}
        </span>
        <span className="ml-auto">
          $PIXEL98 launch: <b>{launchPct.toFixed(1)}%</b> / 10%
        </span>
      </div>

      {activeIndex !== null && (
        <PixelDialog index={activeIndex} onClose={() => setActiveIndex(null)} />
      )}
    </div>
  );
}
