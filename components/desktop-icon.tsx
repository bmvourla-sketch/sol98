"use client";

import type { LucideIcon } from "lucide-react";

interface DesktopIconProps {
  label: string;
  Icon: LucideIcon;
  onDoubleClick: () => void;
}

/** A Win98 desktop shortcut (opens its window on double-click). */
export function DesktopIcon({ label, Icon, onDoubleClick }: DesktopIconProps) {
  return (
    <button
      type="button"
      className="win98-desktop-icon"
      onDoubleClick={onDoubleClick}
      onClick={(event) => {
        // single click selects (visual only)
        (event.currentTarget as HTMLButtonElement).blur();
      }}
    >
      <span className="icon-glyph">
        <Icon size={30} strokeWidth={1.6} color="#fff" style={{ filter: "drop-shadow(1px 1px 0 #000)" }} />
      </span>
      <span>{label}</span>
    </button>
  );
}
