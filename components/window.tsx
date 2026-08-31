"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Minus, Square, X } from "lucide-react";

interface WindowProps {
  title: string;
  active: boolean;
  zIndex: number;
  initialPos: { x: number; y: number };
  size: { width: number; height: number };
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  children: ReactNode;
}

/**
 * A draggable + resizable Windows-98 window. The title bar is the drag handle;
 * the bottom-right grip resizes. Raw pointer events keep both working on mouse
 * and touch. Buttons: minimize / maximize / close.
 */
export function Window({
  title,
  active,
  zIndex,
  initialPos,
  size: initialSize,
  onFocus,
  onClose,
  onMinimize,
  children,
}: WindowProps) {
  const [pos, setPos] = useState(initialPos);
  const [size, setSize] = useState(initialSize);
  const [maximized, setMaximized] = useState(false);

  // Fit windows that would overflow the viewport (phones/tablets).
  useEffect(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.max(240, Math.min(initialSize.width, vw - 12));
    const height = Math.max(160, Math.min(initialSize.height, vh - 48));
    setSize({ width, height });
    setPos({
      x: Math.max(4, Math.min(initialPos.x, vw - width - 4)),
      y: Math.max(4, Math.min(initialPos.y, vh - height - 40)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    onFocus();

    const startX = event.clientX;
    const startY = event.clientY;
    const origX = pos.x;
    const origY = pos.y;

    const onMove = (ev: PointerEvent) =>
      setPos({
        x: Math.max(0, origX + ev.clientX - startX),
        y: Math.max(0, origY + ev.clientY - startY),
      });
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onFocus();

    const startX = event.clientX;
    const startY = event.clientY;
    const origW = size.width;
    const origH = size.height;

    const onMove = (ev: PointerEvent) =>
      setSize({
        width: Math.max(240, origW + ev.clientX - startX),
        height: Math.max(160, origH + ev.clientY - startY),
      });
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const style: React.CSSProperties = maximized
    ? { left: 0, top: 0, width: "100%", height: "100%", zIndex }
    : { left: pos.x, top: pos.y, width: size.width, height: size.height, zIndex };

  return (
    <div
      className="win98-window bevel-out absolute flex flex-col"
      style={style}
      onPointerDownCapture={onFocus}
    >
      <div
        className={`win98-titlebar ${active ? "" : "inactive"}`}
        onPointerDown={startDrag}
        onDoubleClick={() => setMaximized((m) => !m)}
      >
        <span className="flex-1 truncate text-[12px]">{title}</span>
        <button type="button" className="win98-title-button" onClick={onMinimize} aria-label="Minimize">
          <Minus size={8} strokeWidth={3} />
        </button>
        <button
          type="button"
          className="win98-title-button"
          onClick={() => setMaximized((m) => !m)}
          aria-label="Maximize"
        >
          <Square size={8} strokeWidth={2} />
        </button>
        <button type="button" className="win98-title-button" onClick={onClose} aria-label="Close">
          <X size={9} strokeWidth={3} />
        </button>
      </div>
      <div className="relative flex-1 overflow-hidden">{children}</div>
      {!maximized && <div className="win98-resize-grip" onPointerDown={startResize} aria-hidden />}
    </div>
  );
}
