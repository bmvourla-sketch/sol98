"use client";

import { BookOpen, FileText, LayoutGrid, Map, Palette, Store, type LucideIcon } from "lucide-react";

import type { WindowId } from "./desktop";

const ITEMS: { id: WindowId; label: string; Icon: LucideIcon }[] = [
  { id: "board", label: "Board.exe", Icon: LayoutGrid },
  { id: "market", label: "Market.exe", Icon: Store },
  { id: "story", label: "Story.exe", Icon: BookOpen },
  { id: "whitepaper", label: "Whitepaper", Icon: FileText },
  { id: "roadmap", label: "Roadmap.exe", Icon: Map },
  { id: "banner", label: "Banner Maker", Icon: Palette },
];

interface StartMenuProps {
  onOpen: (id: WindowId) => void;
  onClose: () => void;
}

/** Classic Win98 Start menu listing the five app windows. */
export function StartMenu({ onOpen, onClose }: StartMenuProps) {
  return (
    <div className="win98-menu absolute bottom-full left-1 z-[100] w-56 py-1">
      <div className="win98-menu-item font-bold">
        <span className="flex h-6 w-6 items-center justify-center bg-[#000080] text-[10px] text-white">
          S98
        </span>
        SOL-98
      </div>
      <div className="win98-menu-separator" />
      {ITEMS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className="win98-menu-item w-full text-left"
          onClick={() => {
            onOpen(id);
            onClose();
          }}
        >
          <Icon size={16} />
          {label}
        </button>
      ))}
    </div>
  );
}
