"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { usePixels } from "@/lib/pixel-store";
import { BOARD_SIZE, formatSol, TOTAL_SPOTS } from "@/lib/pricing";
import { LAUNCH_TARGET_SPOTS } from "@/lib/token";
import { PixelCell } from "./pixel-cell";
import { PixelDialog } from "./pixel-dialog";

const BASE_CELL = 16; // px at zoom = 1

function rectIndices(start: number, end: number): number[] {
  const r1 = Math.floor(start / BOARD_SIZE);
  const c1 = start % BOARD_SIZE;
  const r2 = Math.floor(end / BOARD_SIZE);
  const c2 = end % BOARD_SIZE;
  const minR = Math.min(r1, r2);
  const maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2);
  const maxC = Math.max(c1, c2);
  const out: number[] = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) out.push(r * BOARD_SIZE + c);
  return out;
}

/**
 * The pixel board on the green desktop: drag to select a rectangular area,
 * release to buy it as one banner. 100×100 blocks (10,000), each 10×10 px.
 * Zoom is driven by the desktop (controls sit next to the wallet).
 */
export function PixelBoard({ zoom }: { zoom: number }) {
  const { pixels, soldCount, nextPriceSol, totalRaisedSol, firstFreeIndex, syncState } =
    usePixels();
  const { connected, publicKey } = useWallet();
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [activeIndices, setActiveIndices] = useState<number[] | null>(null);
  const draggingRef = useRef(false);

  const onSelectStart = useCallback((index: number) => {
    draggingRef.current = true;
    setSel({ start: index, end: index });
  }, []);

  const onSelectMove = useCallback((index: number) => {
    if (draggingRef.current) setSel((s) => (s ? { ...s, end: index } : s));
  }, []);

  const me = publicKey?.toBase58() ?? "";

  const handleMouseUp = useCallback(() => {
    if (draggingRef.current) {
      draggingRef.current = false;
      if (sel) {
        const indices = rectIndices(sel.start, sel.end);
        // Clicking a single owned ad with a link redirects to it (click-through).
        if (indices.length === 1) {
          const p = pixels[indices[0]];
          if (p && p.destination && p.owner !== me) {
            window.open(p.destination, "_blank", "noopener,noreferrer");
            setSel(null);
            return;
          }
        }
        setActiveIndices(indices);
        setSel(null);
      }
    }
  }, [sel, pixels, me]);

  const cells = useMemo(() => {
    let minR = -1, maxR = -1, minC = -1, maxC = -1;
    if (sel) {
      minR = Math.min(Math.floor(sel.start / BOARD_SIZE), Math.floor(sel.end / BOARD_SIZE));
      maxR = Math.max(Math.floor(sel.start / BOARD_SIZE), Math.floor(sel.end / BOARD_SIZE));
      minC = Math.min(sel.start % BOARD_SIZE, sel.end % BOARD_SIZE);
      maxC = Math.max(sel.start % BOARD_SIZE, sel.end % BOARD_SIZE);
    }
    const list: React.ReactElement[] = [];
    for (let i = 0; i < TOTAL_SPOTS; i++) {
      const r = Math.floor(i / BOARD_SIZE);
      const c = i % BOARD_SIZE;
      const selected = sel ? r >= minR && r <= maxR && c >= minC && c <= maxC : false;
      list.push(
        <PixelCell
          key={i}
          index={i}
          pixel={pixels[i]}
          selected={selected}
          onSelectStart={onSelectStart}
          onSelectMove={onSelectMove}
        />
      );
    }
    return list;
  }, [pixels, sel, onSelectStart, onSelectMove]);

  const remaining = Math.max(0, LAUNCH_TARGET_SPOTS - soldCount);
  const launchPct = Math.min(100, (soldCount / LAUNCH_TARGET_SPOTS) * 100);
  const cell = Math.max(1, Math.round(BASE_CELL * zoom));
  const selCount = sel ? rectIndices(sel.start, sel.end).length : 0;

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="win98-button"
          disabled={!connected || firstFreeIndex < 0}
          onClick={() => setActiveIndices([firstFreeIndex])}
        >
          Buy Pixel
        </button>
        <span className="text-xs text-white">
          Next block: <b>{formatSol(nextPriceSol)} SOL</b>
          <span className="text-white/60"> (10×10 · +10%/sale)</span>
        </span>
        {selCount > 1 && (
          <span className="text-xs text-yellow-200">Selected: {selCount} blocks</span>
        )}
        {!connected && <span className="text-[11px] text-yellow-200">Connect wallet to buy</span>}
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

      {/* Board — drag to select an area */}
      <div
        className="bevel-in min-h-0 flex-1 overflow-auto"
        onMouseUp={handleMouseUp}
        onMouseDown={(e) => e.preventDefault()}
      >
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

      {activeIndices !== null && (
        <PixelDialog indices={activeIndices} onClose={() => setActiveIndices(null)} />
      )}
    </div>
  );
}
