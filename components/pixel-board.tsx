"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { usePixels } from "@/lib/pixel-store";
import { BOARD_SIZE, formatSol, TOTAL_SPOTS } from "@/lib/pricing";
import { LAUNCH_TARGET_SPOTS } from "@/lib/token";
import { PixelCell } from "./pixel-cell";
import { PixelDialog } from "./pixel-dialog";

const BASE_CELL = 16; // px at zoom = 1
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;

/**
 * The pixel board — rendered directly on the green desktop, scrollable and
 * zoomable. 200×200 = 40,000 blocks (each 10×10 px). Minimum purchase 10×10,
 * 0.2 SOL, +10% per sale, launch countdown at the 100th sale.
 */
export function PixelBoard() {
  const { pixels, soldCount, nextPriceSol, totalRaisedSol, firstFreeIndex, syncState } =
    usePixels();
  const { connected } = useWallet();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);

  const cells = useMemo(() => {
    const list: React.ReactElement[] = [];
    for (let i = 0; i < TOTAL_SPOTS; i++) {
      list.push(<PixelCell key={i} index={i} pixel={pixels[i]} onInteract={setActiveIndex} />);
    }
    return list;
  }, [pixels]);

  const remaining = Math.max(0, LAUNCH_TARGET_SPOTS - soldCount);
  const launchPct = Math.min(100, (soldCount / LAUNCH_TARGET_SPOTS) * 100);
  const cell = Math.max(1, Math.round(BASE_CELL * zoom));

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {/* Toolbar + zoom */}
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
          <span className="text-white/60"> (10×10 · +10%/sale)</span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" className="win98-button !px-2 !py-0" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.5))}>−</button>
          <span className="w-12 text-center text-xs text-white">{Math.round(zoom * 100)}%</span>
          <button type="button" className="win98-button !px-2 !py-0" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))}>+</button>
          <button type="button" className="win98-button !px-2 !py-0" onClick={() => setZoom(1)}>1:1</button>
        </span>
      </div>

      {/* Launch countdown */}
      <div className="bevel-in flex items-center gap-2 px-2 py-1 text-xs">
        <span>Launch countdown:</span>
        <span>
          <b>{remaining}</b> / {LAUNCH_TARGET_SPOTS} blocks remaining
        </span>
        <div className="bevel-in ml-2 h-4 flex-1 bg-white">
          <div className="h-full bg-[#000080]" style={{ width: `${launchPct}%` }} />
        </div>
      </div>

      {/* Board — scrollable + zoomable */}
      <div className="bevel-in min-h-0 flex-1 overflow-auto">
        <div
          className="pixel-board-grid"
          style={{
            gridTemplateColumns: `repeat(${BOARD_SIZE}, ${cell}px)`,
            gridTemplateRows: `repeat(${BOARD_SIZE}, ${cell}px)`,
          }}
        >
          {cells}
        </div>
      </div>

      {/* Status */}
      <div className="bevel-in flex flex-wrap items-center gap-4 px-2 py-1 text-xs">
        <span>
          Blocks sold: <b>{soldCount}</b> / {TOTAL_SPOTS}
        </span>
        <span>
          {BOARD_SIZE}×{BOARD_SIZE} blocks
        </span>
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
