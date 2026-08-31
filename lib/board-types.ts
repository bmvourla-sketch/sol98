// Shared, framework-agnostic types + pricing for "Start Ads" — a second,
// separate ad product from the main pixel board.
//
// Start Ads sells named "board.exe" files on their own bonding curve
// (2 SOL, +10% per sale). Each file is a 10×10 mini pixel board whose 100
// sub-blocks are owned by the file's buyer and carry the SAME mechanics as
// the main board: edit the ad, list for sale/rent, buy-listing/rent
// (peer-to-peer, SOL or $PIXEL98), and hijack (tiered burn + 5% decay).

import type { AdContent } from "./pixel-types";

export const BOARD_FILE_SIZE = 10; // 10×10
export const BOARD_FILE_BLOCKS = BOARD_FILE_SIZE * BOARD_FILE_SIZE; // 100
export const BOARD_FILE_START_PRICE_SOL = 2;
export const BOARD_FILE_PRICE_INCREASE = 0.1; // +10% per sale

/** Base SOL valuation of a sub-block before any hijack decay. */
export const BOARD_BLOCK_BASE_SOL = 0.2;

export const BOARD_NAME_MAX_LEN = 100;

/** Price of the Nth board.exe file (1-indexed): 2 · 1.10^(N-1). */
export function boardFilePrice(oneBasedIndex: number): number {
  return BOARD_FILE_START_PRICE_SOL * Math.pow(1 + BOARD_FILE_PRICE_INCREASE, oneBasedIndex - 1);
}

/** Price of the next board.exe file, given `soldCount` files already sold. */
export function nextBoardFilePrice(soldCount: number): number {
  return boardFilePrice(soldCount + 1);
}

export interface BoardFile {
  id: string;
  name: string;
  owner: string; // wallet public key (base58)
  purchasedAt: number;
  priceSol: number; // what this file sold for (for display)
}

/** A sub-block inside a board.exe file — mirrors the main board's PixelData. */
export interface BoardPixel extends AdContent {
  boardId: string;
  index: number; // 0..99 within the board
  owner: string; // wallet public key (base58)
  valuationSol: number;
  purchasedAt: number;
  isRented: boolean;
  rentedTo?: string;
  rentedUntil?: number;
  listingPriceSol?: number;
  rentPriceSol?: number;
  listingPricePixel98?: number;
  rentPricePixel98?: number;
}

/** Trims/falls back a board file name; never rejects (always yields a name). */
export function sanitizeBoardName(nameInput: unknown): string {
  const name = typeof nameInput === "string" ? nameInput.trim() : "";
  return (name || "Board.exe").slice(0, BOARD_NAME_MAX_LEN);
}

/** Composite key used to store a sub-block. */
export function boardPixelKey(boardId: string, index: number): string {
  return `${boardId}:${index}`;
}
