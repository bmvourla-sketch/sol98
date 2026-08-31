"use client";

import { useEffect, useState } from "react";

import type { WindowId } from "./desktop";
import { InstallAppButton } from "./install-app";
import { StartMenu } from "./start-menu";

export interface TaskbarWindow {
  id: WindowId;
  title: string;
  minimized: boolean;
  active: boolean;
}

interface TaskbarProps {
  windows: TaskbarWindow[];
  startOpen: boolean;
  onStartToggle: () => void;
  onOpenWindow: (id: WindowId) => void;
  onWindowClick: (id: WindowId) => void;
}

/** The Win98 taskbar: Start button, running windows, and a system tray. */
export function Taskbar({
  windows,
  startOpen,
  onStartToggle,
  onOpenWindow,
  onWindowClick,
}: TaskbarProps) {
  const [time, setTime] = useState("");

  useEffect(() => {
    const update = () =>
      setTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="win98-taskbar">
      <button
        type="button"
        className={`win98-taskbar-button font-bold ${startOpen ? "active" : ""}`}
        onClick={onStartToggle}
      >
        {/* mini 4-color Windows logo */}
        <span className="grid grid-cols-2 gap-[1px]">
          <span className="h-[6px] w-[6px] bg-[#f35325]" />
          <span className="h-[6px] w-[6px] bg-[#81bc06]" />
          <span className="h-[6px] w-[6px] bg-[#05a6f0]" />
          <span className="h-[6px] w-[6px] bg-[#ffba08]" />
        </span>
        Start
      </button>

      <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-hidden">
        {windows.map((w) => (
          <button
            key={w.id}
            type="button"
            className={`win98-taskbar-button min-w-0 ${w.active && !w.minimized ? "active" : ""}`}
            onClick={() => onWindowClick(w.id)}
          >
            <span className="truncate">{w.title}</span>
          </button>
        ))}
      </div>

      <div className="win98-tray">
        <a href="https://x.com/solwin98" target="_blank" rel="noopener noreferrer" aria-label="X" className="tray-social flex items-center text-black hover:text-[#000080]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
        </a>
        <a href="https://t.me/SoLwin98" target="_blank" rel="noopener noreferrer" aria-label="Telegram" className="tray-social flex items-center text-black hover:text-[#000080]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
        </a>
        <InstallAppButton />
        <span className="text-[11px] tabular-nums">{time}</span>
      </div>

      {startOpen && <StartMenu onOpen={onOpenWindow} onClose={onStartToggle} />}
    </div>
  );
}
