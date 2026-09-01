"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { usePixels } from "@/lib/pixel-store";
import { BOARD_SIZE, formatSol, TOTAL_SPOTS } from "@/lib/pricing";
import { LAUNCH_TARGET_SPOTS } from "@/lib/token";
import { isSafeLinkUrl } from "@/lib/pixel-types";
import { PixelCell, PIXEL_INDEX_ATTR } from "./pixel-cell";
import { PixelDialog } from "./pixel-dialog";

const BASE_CELL = 16; // px at zoom = 1
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;

// SOL-98 — mobile/touch multi-select. Press and hold a block for this long
// (with the finger staying within LONG_PRESS_CANCEL_PX of where it started)
// to enter selection mode; moving further before that fires is treated as an
// ordinary scroll instead, so the gesture never hijacks normal scrolling.
const LONG_PRESS_MS = 350;
const LONG_PRESS_CANCEL_PX = 10;

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
  const [touchCapable, setTouchCapable] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    setTouchCapable(coarse || navigator.maxTouchPoints > 0 || "ontouchstart" in window);
  }, []);

  // Zoom-to-point machinery.
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  const anchorRef = useRef<{ ratioX: number; ratioY: number; offsetX: number; offsetY: number } | null>(null);
  const pinchRef = useRef<{ dist: number } | null>(null);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  const onSelectStart = useCallback((index: number) => {
    draggingRef.current = true;
    setSel({ start: index, end: index });
  }, []);

  const onSelectMove = useCallback((index: number) => {
    if (draggingRef.current) setSel((s) => (s ? { ...s, end: index } : s));
  }, []);

  const me = publicKey?.toBase58() ?? "";

  // Mouse drag and touch long-press-drag both funnel into this: it's read by
  // a native (non-React) touchend listener below, so it's kept stable and
  // reads the latest sel/pixels/me off a ref instead of closing over them.
  const latestRef = useRef({ sel, pixels, me });
  useEffect(() => {
    latestRef.current = { sel, pixels, me };
  }, [sel, pixels, me]);

  const finalizeSelection = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const { sel: currentSel, pixels: currentPixels, me: currentMe } = latestRef.current;
    if (!currentSel) return;
    const indices = rectIndices(currentSel.start, currentSel.end);
    // Clicking/tapping a single owned ad with a link redirects to it (click-through).
    if (indices.length === 1) {
      const p = currentPixels[indices[0]];
      // Re-validated here (not just on write) — defense in depth against
      // any pixel written before this check existed.
      if (p && p.destination && p.owner !== currentMe && isSafeLinkUrl(p.destination)) {
        window.open(p.destination, "_blank", "noopener,noreferrer");
        setSel(null);
        return;
      }
    }
    setActiveIndices(indices);
    setSel(null);
  }, []);

  const handleMouseUp = useCallback(() => {
    finalizeSelection();
  }, [finalizeSelection]);

  // A gesture that gets interrupted (e.g. a second finger touches down mid
  // long-press-drag) discards the in-progress rectangle instead of leaving a
  // dangling half-made selection on screen.
  const cancelSelection = useCallback(() => {
    draggingRef.current = false;
    setSel(null);
  }, []);

  // A drag that starts on the board (mousedown on a cell) but is released
  // somewhere the local onMouseUp below never sees — over a floating Window,
  // the Start Menu, or outside the browser entirely — used to leave
  // `draggingRef`/`sel` dangling. The *next*, unrelated mouseup that later
  // bubbled through the board would then finalize that stale rectangle,
  // which is what made window-close clicks and Start Menu clicks appear to
  // "leak through" into an unintended pixel selection/purchase. Listening on
  // `window` catches every release no matter where it lands: finalize only
  // if it actually landed back on the board, otherwise cancel the drag.
  useEffect(() => {
    function onGlobalMouseUp(e: MouseEvent) {
      if (!draggingRef.current) return;
      const target = e.target as Node | null;
      const releasedOnBoard = !!(target && scrollRef.current?.contains(target));
      if (releasedOnBoard) {
        finalizeSelection();
      } else {
        cancelSelection();
      }
    }
    window.addEventListener("mouseup", onGlobalMouseUp);
    return () => window.removeEventListener("mouseup", onGlobalMouseUp);
  }, [finalizeSelection, cancelSelection]);

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

    // --- Mobile/touch multi-select: press and hold a block, then drag to
    // extend a rectangle (the touch equivalent of the desktop mouse-drag
    // area-select) — release to buy the area as one banner, same as mouse.
    //
    // Touch events don't retarget as the finger moves: touchmove/touchend
    // keep firing on whatever element touchstart began on, unlike mouse
    // where onMouseEnter naturally fires per-element during a drag. So the
    // cell "under the finger" is found manually via elementFromPoint + the
    // data-pixel-index attribute PixelCell renders, each time the finger
    // moves — the touch analogue of onSelectMove's per-cell onMouseEnter.
    //
    // Nothing here is hijacked until a long-press is confirmed: a quick tap
    // (touchstart+touchend with no real movement) is left alone, so it still
    // falls through to the browser's normal synthesized mouse/click events
    // that already open the single-pixel dialog today. And a finger that
    // moves past LONG_PRESS_CANCEL_PX before the timer fires is treated as
    // an ordinary scroll, not a selection attempt, and nothing is prevented.
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let touchStartPoint: { x: number; y: number } | null = null;
    let selectDragActive = false;

    function clearLongPressTimer() {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }

    function indexFromTouchPoint(clientX: number, clientY: number): number | null {
      const hit = document.elementFromPoint(clientX, clientY);
      const cellEl = hit instanceof Element ? hit.closest(`[${PIXEL_INDEX_ATTR}]`) : null;
      const raw = cellEl?.getAttribute(PIXEL_INDEX_ATTR);
      if (raw === null || raw === undefined) return null;
      const idx = Number(raw);
      return Number.isFinite(idx) ? idx : null;
    }

    function onTouchStartSelect(e: TouchEvent) {
      clearLongPressTimer();
      if (e.touches.length !== 1) {
        // A second finger means this is a pinch-zoom gesture, not a selection.
        if (selectDragActive) cancelSelection();
        selectDragActive = false;
        touchStartPoint = null;
        return;
      }
      const t = e.touches[0];
      touchStartPoint = { x: t.clientX, y: t.clientY };
      const idx = indexFromTouchPoint(t.clientX, t.clientY);
      if (idx === null) return;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        selectDragActive = true;
        onSelectStart(idx);
        // Best-effort tactile confirmation that selection mode has started;
        // unsupported on most desktops/iOS Safari, silently ignored there.
        if (typeof navigator !== "undefined") navigator.vibrate?.(12);
      }, LONG_PRESS_MS);
    }

    function onTouchMoveSelect(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (selectDragActive) {
        e.preventDefault(); // take over the gesture from page scroll while dragging
        const idx = indexFromTouchPoint(t.clientX, t.clientY);
        if (idx !== null) onSelectMove(idx);
        return;
      }
      if (longPressTimer !== null && touchStartPoint) {
        const dx = t.clientX - touchStartPoint.x;
        const dy = t.clientY - touchStartPoint.y;
        if (Math.hypot(dx, dy) > LONG_PRESS_CANCEL_PX) clearLongPressTimer();
      }
    }

    function onTouchEndSelect(e: TouchEvent) {
      clearLongPressTimer();
      if (selectDragActive) {
        // Swallow the synthetic mouse/click events the browser would
        // otherwise replay after this touch — finalizeSelection() below
        // already does what that synthetic click would have triggered.
        e.preventDefault();
        selectDragActive = false;
        finalizeSelection();
      }
      touchStartPoint = null;
    }

    function onTouchCancelSelect() {
      clearLongPressTimer();
      if (selectDragActive) cancelSelection();
      selectDragActive = false;
      touchStartPoint = null;
    }

    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("touchstart", onTouchStart, { passive: false });
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    node.addEventListener("touchend", onTouchEnd);
    node.addEventListener("touchstart", onTouchStartSelect, { passive: false });
    node.addEventListener("touchmove", onTouchMoveSelect, { passive: false });
    node.addEventListener("touchend", onTouchEndSelect, { passive: false });
    node.addEventListener("touchcancel", onTouchCancelSelect);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchstart", onTouchStartSelect);
      node.removeEventListener("touchmove", onTouchMoveSelect);
      node.removeEventListener("touchend", onTouchEndSelect);
      node.removeEventListener("touchcancel", onTouchCancelSelect);
      clearLongPressTimer();
    };
  }, [onZoomChange, onSelectStart, onSelectMove, finalizeSelection, cancelSelection]);

  // After the grid re-renders at the new zoom, keep the anchored point still.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    el.scrollLeft = anchor.ratioX * el.scrollWidth - anchor.offsetX;
    el.scrollTop = anchor.ratioY * el.scrollHeight - anchor.offsetY;
    anchorRef.current = null;
  }, [zoom]);

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
          {touchCapable && selCount <= 1 && (
            <span className="text-[11px] text-white/70">
              Tip: press &amp; hold a block, then drag to select an area — release to buy
            </span>
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
