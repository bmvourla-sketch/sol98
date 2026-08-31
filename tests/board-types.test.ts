import { describe, expect, it } from "vitest";

import {
  BOARD_FILE_BLOCKS,
  BOARD_FILE_START_PRICE_SOL,
  boardFilePrice,
  boardPixelKey,
  nextBoardFilePrice,
  sanitizeBoardName,
} from "../lib/board-types";

describe("board-types (Start Ads)", () => {
  it("a board.exe file is 10×10 = 100 blocks", () => {
    expect(BOARD_FILE_BLOCKS).toBe(100);
  });

  it("board.exe pricing starts at 2 SOL and rises 10% per sale", () => {
    expect(BOARD_FILE_START_PRICE_SOL).toBe(2);
    expect(boardFilePrice(1)).toBeCloseTo(2);
    expect(boardFilePrice(2)).toBeCloseTo(2.2);
    expect(boardFilePrice(3)).toBeCloseTo(2.42);
    expect(nextBoardFilePrice(0)).toBeCloseTo(2);
    expect(nextBoardFilePrice(1)).toBeCloseTo(2.2);
  });

  it("sanitizeBoardName falls back and trims", () => {
    expect(sanitizeBoardName("My Board")).toBe("My Board");
    expect(sanitizeBoardName("  ")).toBe("Board.exe");
    expect(sanitizeBoardName(null)).toBe("Board.exe");
  });

  it("boardPixelKey composes boardId and index", () => {
    expect(boardPixelKey("b-1", 5)).toBe("b-1:5");
  });
});
