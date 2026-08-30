"use client";

import { useCallback, useState } from "react";
import { BookOpen, FileText, LayoutGrid, Map, Store, type LucideIcon } from "lucide-react";

import { PixelProvider } from "@/lib/pixel-store";
import { DesktopIcon } from "./desktop-icon";
import { Market } from "./market";
import { PixelBoard } from "./pixel-board";
import { Roadmap } from "./roadmap";
import { Story } from "./story";
import { Taskbar } from "./taskbar";
import { Whitepaper } from "./whitepaper";
import { Window } from "./window";

export type WindowId = "board" | "market" | "story" | "whitepaper" | "roadmap";

interface WinDef {
  title: string;
  Icon: LucideIcon;
  Component: React.ComponentType;
  pos: { x: number; y: number };
  size: { width: number; height: number };
}

const WINDOWS: Record<WindowId, WinDef> = {
  board: {
    title: "Board.exe",
    Icon: LayoutGrid,
    Component: PixelBoard,
    pos: { x: 40, y: 24 },
    size: { width: 660, height: 780 },
  },
  market: {
    title: "Market.exe",
    Icon: Store,
    Component: Market,
    pos: { x: 120, y: 60 },
    size: { width: 520, height: 460 },
  },
  story: {
    title: "Story.exe",
    Icon: BookOpen,
    Component: Story,
    pos: { x: 180, y: 100 },
    size: { width: 480, height: 400 },
  },
  whitepaper: {
    title: "Readme.txt",
    Icon: FileText,
    Component: Whitepaper,
    pos: { x: 210, y: 130 },
    size: { width: 520, height: 500 },
  },
  roadmap: {
    title: "Roadmap.exe",
    Icon: Map,
    Component: Roadmap,
    pos: { x: 240, y: 160 },
    size: { width: 480, height: 440 },
  },
};

const DESKTOP_ICON_ORDER: WindowId[] = ["board", "market", "story", "whitepaper", "roadmap"];

export default function Desktop() {
  // `order` is also the z-order: the last item is the topmost window.
  const [order, setOrder] = useState<WindowId[]>(["board"]);
  const [minimized, setMinimized] = useState<Partial<Record<WindowId, boolean>>>({});
  const [active, setActive] = useState<WindowId | null>("board");
  const [startOpen, setStartOpen] = useState(false);

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
      <div className="flex h-screen flex-col overflow-hidden">
        <div className="relative flex-1">
          {/* Top-right quick access */}
          <div className="absolute right-2 top-2 z-0 flex gap-1">
            <button type="button" className="win98-button" onClick={() => openWindow("whitepaper")}>
              Whitepaper
            </button>
            <button type="button" className="win98-button" onClick={() => openWindow("story")}>
              Story
            </button>
            <button type="button" className="win98-button" onClick={() => openWindow("roadmap")}>
              Roadmap
            </button>
          </div>

          {/* Desktop shortcuts */}
          <div className="absolute left-3 top-3 z-0 flex flex-col gap-1">
            {DESKTOP_ICON_ORDER.map((id) => {
              const def = WINDOWS[id];
              return (
                <DesktopIcon
                  key={id}
                  label={def.title}
                  Icon={def.Icon}
                  onDoubleClick={() => openWindow(id)}
                />
              );
            })}
          </div>

          {/* Windows (z-order = array order) */}
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

        <Taskbar
          windows={taskbarWindows}
          startOpen={startOpen}
          onStartToggle={() => setStartOpen((o) => !o)}
          onOpenWindow={openWindow}
          onWindowClick={(id) => (minimized[id] ? openWindow(id) : focusWindow(id))}
        />
      </div>
    </PixelProvider>
  );
}
