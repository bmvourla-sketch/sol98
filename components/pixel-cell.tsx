"use client";

import { memo } from "react";

import type { NeonTemplate, PixelData } from "@/lib/pixel-store";
import { shortenAddress } from "@/lib/solana";

interface PixelCellProps {
  index: number;
  pixel?: PixelData;
  selected?: boolean;
  onSelectStart: (index: number) => void;
  onSelectMove: (index: number) => void;
}

const NEON_CLASS: Partial<Record<NeonTemplate, string>> = {
  "cyberpunk-pulse": "neon-cyberpunk-pulse",
  matrix: "neon-matrix",
  flashing: "neon-flashing",
  glitch: "neon-glitch",
};

/**
 * A single 10×10-pixel block. Drag across cells to select a rectangular area;
 * releasing opens the buy dialog. Owned cells render the ad image (spanning
 * across the banner when part of a multi-block purchase) + neon template.
 */
export const PixelCell = memo(function PixelCell({
  index,
  pixel,
  selected,
  onSelectStart,
  onSelectMove,
}: PixelCellProps) {
  const neonClass = pixel && pixel.neon !== "none" ? NEON_CLASS[pixel.neon] ?? "" : "";

  const style: React.CSSProperties = {};
  if (pixel?.imageUrl) {
    if (pixel.bannerGroupId && pixel.bannerCols && pixel.bannerRows) {
      const { bannerCols, bannerRows, bannerX = 0, bannerY = 0 } = pixel;
      style.backgroundImage = `url("${pixel.imageUrl}")`;
      style.backgroundSize = `${bannerCols * 100}% ${bannerRows * 100}%`;
      style.backgroundPosition = `${bannerCols > 1 ? (bannerX / (bannerCols - 1)) * 100 : 0}% ${
        bannerRows > 1 ? (bannerY / (bannerRows - 1)) * 100 : 0
      }%`;
      style.backgroundRepeat = "no-repeat";
    } else {
      style.backgroundImage = `url("${pixel.imageUrl}")`;
      style.backgroundSize = "cover";
      style.backgroundPosition = "center";
    }
  }
  if (selected) {
    style.boxShadow = "inset 0 0 0 999px rgba(0, 0, 128, 0.45)";
  }

  return (
    <button
      type="button"
      className={`pixel-cell${pixel ? " owned" : ""}${neonClass ? ` ${neonClass}` : ""}`}
      style={style}
      onMouseDown={(e) => {
        if (e.button === 0) onSelectStart(index);
      }}
      onMouseEnter={() => onSelectMove(index)}
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
