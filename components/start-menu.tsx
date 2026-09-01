"use client";

import { useState } from "react";
import { BookOpen, FileText, FolderOpen, Map, Palette, Store, type LucideIcon } from "lucide-react";

import type { WindowId } from "./desktop";
import { StartAdsMenu } from "./start-ads";

const ITEMS: { id: WindowId; label: string; Icon: LucideIcon }[] = [
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

/** Classic Win98 Start menu. "Start Ads" is a folder that opens a side flyout. */
export function StartMenu({ onOpen, onClose }: StartMenuProps) {
  const [adsOpen, setAdsOpen] = useState(false);

  return (
    <>
      {/* Full-screen backdrop: catches the outside click that should just
          dismiss the menu, so it doesn't also fall through and act on
          whatever's underneath (the pixel canvas, a window, ...). `fixed`
          so it covers the viewport regardless of where the taskbar sits in
          the DOM, and it sits below the menu (z-90 < z-100) but above
          everything else. */}
      <div
        className="fixed inset-0 z-[90]"
        onMouseDown={(e) => {
          e.preventDefault();
          onClose();
        }}
        aria-hidden
      />
      <div className="win98-menu absolute bottom-full left-1 z-[100] w-56 py-1">
      <div className="win98-menu-item font-bold">
        <span className="flex h-6 w-6 items-center justify-center bg-[#000080] text-[10px] text-white">
          S98
        </span>
        SOL-98
      </div>
      <div className="win98-menu-separator" />

      {/* Start Ads — a folder that opens a side flyout (standard Start bar style) */}
      <div className="relative" onMouseLeave={() => setAdsOpen(false)}>
        <button
          type="button"
          className="win98-menu-item w-full text-left"
          onClick={() => setAdsOpen((o) => !o)}
          onMouseEnter={() => setAdsOpen(true)}
        >
          <FolderOpen size={16} color="#f0b000" />
          <span className="flex-1">Start Ads</span>
          <span className="text-[10px]">▸</span>
        </button>
        {adsOpen && (
          <div className="win98-menu absolute left-full top-0 w-60 py-1">
            <StartAdsMenu onClose={onClose} />
          </div>
        )}
      </div>

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
    </>
  );
}
