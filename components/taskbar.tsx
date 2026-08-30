"use client";

import { useEffect, useState } from "react";

import type { WindowId } from "./desktop";
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
        <span className="text-[11px] tabular-nums">{time}</span>
      </div>

      {startOpen && <StartMenu onOpen={onOpenWindow} onClose={onStartToggle} />}
    </div>
  );
}
