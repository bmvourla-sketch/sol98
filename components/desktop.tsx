"use client";

import { useCallback, useState } from "react";

import { DocumentProvider } from "@/lib/document-store";
import { PixelProvider } from "@/lib/pixel-store";
import { DocumentSale } from "./document-sale";
import { BannerMaker } from "./banner-maker";
import { Market } from "./market";
import { PixelBoard } from "./pixel-board";
import { Roadmap } from "./roadmap";
import { SolanaConnectButton } from "./solana-connect-button";
import { Story } from "./story";
import { Taskbar } from "./taskbar";
import { Whitepaper } from "./whitepaper";
import { Window } from "./window";

export type WindowId = "board" | "market" | "story" | "whitepaper" | "roadmap" | "banner";

interface WinDef {
  title: string;
  Component: React.ComponentType;
  pos: { x: number; y: number };
  size: { width: number; height: number };
}

const WINDOWS: Record<WindowId, WinDef> = {
  board: {
    title: "Board.exe",
    Component: DocumentSale,
    pos: { x: 60, y: 40 },
    size: { width: 560, height: 480 },
  },
  market: {
    title: "Market.exe",
    Component: Market,
    pos: { x: 120, y: 60 },
    size: { width: 520, height: 460 },
  },
  story: {
    title: "Story.exe",
    Component: Story,
    pos: { x: 160, y: 90 },
    size: { width: 480, height: 420 },
  },
  whitepaper: {
    title: "Whitepaper",
    Component: Whitepaper,
    pos: { x: 190, y: 120 },
    size: { width: 540, height: 540 },
  },
  roadmap: {
    title: "Roadmap.exe",
    Component: Roadmap,
    pos: { x: 220, y: 150 },
    size: { width: 480, height: 460 },
  },
  banner: {
    title: "Banner.exe",
    Component: BannerMaker,
    pos: { x: 100, y: 50 },
    size: { width: 460, height: 620 },
  },
};

export default function Desktop() {
  // `order` is also the z-order: the last item is the topmost window. Starts
  // empty — the pixel board is the desktop itself, and windows open on demand.
  const [order, setOrder] = useState<WindowId[]>([]);
  const [minimized, setMinimized] = useState<Partial<Record<WindowId, boolean>>>({});
  const [active, setActive] = useState<WindowId | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [zoom, setZoom] = useState(1);

  const openWindow = useCallback((id: WindowId) => {
    setOrder((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setMinimized((prev) => ({ ...prev, [id]: false }));
    setActive(id);
  }, []);

  const closeWindow = useCallback(
    (id: WindowId) => {
      setOrder((prev) => prev.filter((w) => w !== id));
      setActive((prevActive) => {
        if (prevActive !== id) return prevActive;
        const remaining = order.filter((w) => w !== id);
        return remaining.length ? remaining[remaining.length - 1] : null;
      });
    },
    [order]
  );

  const minimizeWindow = useCallback((id: WindowId) => {
    setMinimized((prev) => ({ ...prev, [id]: true }));
  }, []);

  const focusWindow = useCallback((id: WindowId) => {
    setOrder((prev) => [...prev.filter((w) => w !== id), id]);
    setActive(id);
    setMinimized((prev) => ({ ...prev, [id]: false }));
  }, []);

  const taskbarWindows = order.map((id) => ({
    id,
    title: WINDOWS[id].title,
    minimized: !!minimized[id],
    active: active === id,
  }));

  return (
    <PixelProvider>
      <DocumentProvider>
        <div className="flex h-screen flex-col overflow-hidden">
          {/* Green desktop = the pixel board */}
          <div className="relative flex-1 overflow-hidden">
            {/* Floating wallet + zoom (top-right, no bar) */}
            <div className="absolute right-2 top-2 z-20 flex items-center gap-1">
              <button type="button" className="win98-button !px-2 !py-0 text-[11px]" onClick={() => setZoom((z) => Math.max(0.2, z / 1.5))}>−</button>
              <span className="w-10 text-center text-[11px] text-white">{Math.round(zoom * 100)}%</span>
              <button type="button" className="win98-button !px-2 !py-0 text-[11px]" onClick={() => setZoom((z) => Math.min(8, z * 1.5))}>+</button>
              <button type="button" className="win98-button !px-2 !py-0 text-[11px]" onClick={() => setZoom(1)}>1:1</button>
              <SolanaConnectButton />
            </div>
            <div className="h-full overflow-auto bg-[#008080]">
              <PixelBoard zoom={zoom} />
            </div>

            {/* Floating windows (draggable) */}
            {order.map((id, i) => {
              if (minimized[id]) return null;
              const def = WINDOWS[id];
              const Comp = def.Component;
              return (
                <Window
                  key={id}
                  title={def.title}
                  active={active === id}
                  zIndex={10 + i}
                  initialPos={def.pos}
                  size={def.size}
                  onFocus={() => focusWindow(id)}
                  onClose={() => closeWindow(id)}
                  onMinimize={() => minimizeWindow(id)}
                >
                  <Comp />
                </Window>
              );
            })}
          </div>

          {/* Bottom taskbar */}
          <Taskbar
            windows={taskbarWindows}
            startOpen={startOpen}
            onStartToggle={() => setStartOpen((o) => !o)}
            onOpenWindow={openWindow}
            onWindowClick={(id) => (minimized[id] ? openWindow(id) : focusWindow(id))}
          />
        </div>
      </DocumentProvider>
    </PixelProvider>
  );
}
