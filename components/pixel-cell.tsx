"use client";

import { memo } from "react";

import type { NeonTemplate, PixelData } from "@/lib/pixel-store";
import { shortenAddress } from "@/lib/solana";

interface PixelCellProps {
  index: number;
  pixel?: PixelData;
  onInteract: (index: number) => void;
}

const NEON_CLASS: Partial<Record<NeonTemplate, string>> = {
  "cyberpunk-pulse": "neon-cyberpunk-pulse",
  matrix: "neon-matrix",
  flashing: "neon-flashing",
  glitch: "neon-glitch",
};

/**
 * A single 10x10-pixel spot. Clicking opens the interaction dialog (buy if
 * empty, hijack if owned by someone else, manage if owned by you). Owned cells
 * render the ad image and apply the selected neon template; hovering shows the
 * owner + message tooltip.
 */
export const PixelCell = memo(function PixelCell({ index, pixel, onInteract }: PixelCellProps) {
  const neonClass = pixel && pixel.neon !== "none" ? NEON_CLASS[pixel.neon] ?? "" : "";

  return (
    <button
      type="button"
      className={`pixel-cell${pixel ? " owned" : ""}${neonClass ? ` ${neonClass}` : ""}`}
      onClick={() => onInteract(index)}
      style={pixel?.imageUrl ? { backgroundImage: `url("${pixel.imageUrl}")` } : undefined}
      aria-label={pixel ? `Pixel ${index + 1} — ${pixel.owner}` : `Pixel ${index + 1} — buy`}
    >
      {pixel && (
        <span className={`pixel-tooltip${neonClass ? ` ${neonClass}` : ""}`}>
          <b>{shortenAddress(pixel.owner, 6)}</b>
          {pixel.message && <span> · {pixel.message}</span>}
          {pixel.isRented && <span> · rented</span>}
        </span>
      )}
    </button>
  );
});
