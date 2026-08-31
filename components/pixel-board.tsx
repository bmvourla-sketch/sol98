"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { usePixels } from "@/lib/pixel-store";
import { BOARD_SIZE, formatSol, TOTAL_SPOTS } from "@/lib/pricing";
import { LAUNCH_TARGET_SPOTS } from "@/lib/token";
import { isSafeLinkUrl } from "@/lib/pixel-types";
import { PixelCell } from "./pixel-cell";
import { PixelDialog } from "./pixel-dialog";

const BASE_CELL = 16; // px at zoom = 1
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

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
 *
 * Zoom is driven by the desktop (controls sit next to the wallet), but the
 * board itself supports mouse-wheel and touch-pinch zoom that anchors on the
 * pointer/touch center — so you zoom toward the point you're looking at.
 */
export function PixelBoard({
  zoom,
  onZoomChange,
}: {
  zoom: number;
  onZoomChange: (zoom: number) => void;
}) {
  const { pixels, soldCount, nextPriceSol, totalRaisedSol, firstFreeIndex, syncState } =
    usePixels();
  const { connected, publicKey } = useWallet();
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [activeIndices, setActiveIndices] = useState<number[] | null>(null);
  const draggingRef = useRef(false);

  // Zoom-to-point machinery.
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  const anchorRef = useRef<{ ratioX: number; ratioY: number; offsetX: number; offsetY: number } | null>(null);
  const pinchRef = useRef<{ dist: number } | null>(null);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // Attach wheel + touch listeners with `passive: false` (React attaches these
  // passively, which would make preventDefault a no-op — and we must stop the
  // page from scrolling/zoom the page while we zoom the board instead).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const node = el;

    function setAnchor(clientX: number, clientY: number) {
      const rect = node.getBoundingClientRect();
      const offsetX = clientX - rect.left;
      const offsetY = clientY - rect.top;
      anchorRef.current = {
        ratioX: node.scrollWidth ? (node.scrollLeft + offsetX) / node.scrollWidth : 0,
        ratioY: node.scrollHeight ? (node.scrollTop + offsetY) / node.scrollHeight : 0,
        offsetX,
        offsetY,
      };
    }

    function applyZoom(factor: number) {
      const next = clampZoom(zoomRef.current * factor);
      if (next !== zoomRef.current) {
        zoomRef.current = next;
        onZoomChange(next);
      }
    }

    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return; // plain wheel scrolls; Ctrl+wheel zooms to the cursor
      e.preventDefault();
      setAnchor(e.clientX, e.clientY);
      applyZoom(Math.exp(-e.deltaY * 0.0015));
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        pinchRef.current = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (e.touches.length !== 2 || !pinchRef.current) return;
      e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      const newDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinchRef.current.dist <= 0) {
        pinchRef.current.dist = newDist;
        return;
      }
      setAnchor((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      applyZoom(newDist / pinchRef.current.dist);
      pinchRef.current.dist = newDist;
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) pinchRef.current = null;
    }

    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("touchstart", onTouchStart, { passive: false });
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    node.addEventListener("touchend", onTouchEnd);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
    };
  }, [onZoomChange]);

  // After the grid re-renders at the new zoom, keep the anchored point still.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    el.scrollLeft = anchor.ratioX * el.scrollWidth - anchor.offsetX;
    el.scrollTop = anchor.ratioY * el.scrollHeight - anchor.offsetY;
    anchorRef.current = null;
  }, [zoom]);

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
          // Re-validated here (not just on write) — defense in depth against
          // any pixel written before this check existed.
          if (p && p.destination && p.owner !== me && isSafeLinkUrl(p.destination)) {
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
      {/* Toolbar: Buy Pixel stays on its own line on mobile (aligned with the
          top-right zoom/wallet controls); the info text sits below it. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <button
          type="button"
          className="win98-button w-fit"
          disabled={!connected || firstFreeIndex < 0}
          onClick={() => setActiveIndices([firstFreeIndex])}
        >
          Buy Pixel
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-white">
            Next block: <b>{formatSol(nextPriceSol)} SOL</b>
            <span className="text-white/60"> (10×10 · +10%/sale)</span>
          </span>
          {selCount > 1 && (
            <span className="text-xs text-yellow-200">Selected: {selCount} blocks</span>
          )}
          {!connected && <span className="text-[11px] text-yellow-200">Connect wallet to buy</span>}
        </div>
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

      {/* Board — drag to select an area; wheel/pinch to zoom at the pointer */}
      <div
        ref={scrollRef}
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
