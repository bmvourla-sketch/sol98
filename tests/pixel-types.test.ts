import { describe, expect, it } from "vitest";

import {
  computeBannerLayout,
  isAdValidationError,
  isSafeImageUrl,
  isSafeLinkUrl,
  sanitizeAdContent,
} from "../lib/pixel-types";

describe("isSafeLinkUrl — destination click-through links", () => {
  it("allows empty (no link set)", () => {
    expect(isSafeLinkUrl("")).toBe(true);
  });

  it("allows http and https", () => {
    expect(isSafeLinkUrl("https://example.com")).toBe(true);
    expect(isSafeLinkUrl("http://example.com/path?x=1")).toBe(true);
  });

  it("rejects javascript: and data: URIs (XSS via window.open click-through)", () => {
    expect(isSafeLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects other schemes and bare strings", () => {
    expect(isSafeLinkUrl("ftp://example.com")).toBe(false);
    expect(isSafeLinkUrl("not a url")).toBe(false);
  });
});

describe("isSafeImageUrl — ad image / Banner.exe export", () => {
  it("allows http(s) and data:image/*;base64 (Banner.exe canvas export)", () => {
    expect(isSafeImageUrl("https://example.com/logo.png")).toBe(true);
    expect(isSafeImageUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
  });

  it("rejects javascript: and non-image data URIs", () => {
    expect(isSafeImageUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeImageUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
  });
});

describe("sanitizeAdContent", () => {
  it("trims fields and defaults an unknown neon template to 'none'", () => {
    const result = sanitizeAdContent({
      destination: "  https://example.com  ",
      imageUrl: "",
      message: "  gm  ",
      neon: "not-a-real-template",
    });
    expect(isAdValidationError(result)).toBe(false);
    if (!isAdValidationError(result)) {
      expect(result.destination).toBe("https://example.com");
      expect(result.message).toBe("gm");
      expect(result.neon).toBe("none");
    }
  });

  it("rejects an unsafe destination instead of silently dropping it", () => {
    const result = sanitizeAdContent({ destination: "javascript:alert(1)" });
    expect(isAdValidationError(result)).toBe(true);
    if (isAdValidationError(result)) expect(result.field).toBe("destination");
  });

  it("rejects an over-long tooltip message", () => {
    const result = sanitizeAdContent({ message: "x".repeat(500) });
    expect(isAdValidationError(result)).toBe(true);
  });
});

describe("computeBannerLayout", () => {
  it("derives the bounding rectangle of a set of board indices", () => {
    // 100-wide board, indices for a 2x3 block starting at row 1, col 2.
    const boardSize = 100;
    const indices = [102, 103, 202, 203, 302, 303];
    const layout = computeBannerLayout(indices, boardSize);
    expect(layout).toEqual({ cols: 2, rows: 3, minRow: 1, minCol: 2 });
  });
});
