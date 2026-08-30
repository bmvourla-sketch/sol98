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
 * A single 10×10-pixel block. Clicking opens the interaction dialog (buy if
 * empty, hijack if owned by someone else, manage if owned by you). Owned cells
 * render the ad image and apply the selected neon template; hovering shows a
 * zoomed tooltip (image + owner + message).
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
          {pixel.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={pixel.imageUrl} alt="Ad" className="h-12 w-12 object-cover" />
          )}
          <b>{shortenAddress(pixel.owner, 6)}</b>
          {pixel.message && <span> · {pixel.message}</span>}
          {pixel.isRented && <span> · rented</span>}
        </span>
      )}
    </button>
  );
});
