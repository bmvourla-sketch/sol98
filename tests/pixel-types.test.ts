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

  // SOL-98 Phase 6 (RED-TEAM HARDENING — BULGU 7): data:image/svg+xml can
  // carry an executable <script>/event-handler if ever rendered a different
  // way than today's <img>/CSSOM usage — see the isSafeImageUrl doc comment.
  it("rejects data:image/svg+xml (BULGU 7 — potential script vector)", () => {
    expect(isSafeImageUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(false);
  });

  it("rejects data:image/gif — data-URI GIFs are no longer accepted (raster png/jpeg/webp only)", () => {
    expect(isSafeImageUrl("data:image/gif;base64,R0lGODlh")).toBe(false);
  });

  it("still allows an http(s)-hosted .gif — only the inline data: form is restricted", () => {
    expect(isSafeImageUrl("https://example.com/banner.gif")).toBe(true);
  });

  it("allows jpeg and webp data URIs", () => {
    expect(isSafeImageUrl("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
    expect(isSafeImageUrl("data:image/jpg;base64,/9j/4AAQ")).toBe(true);
    expect(isSafeImageUrl("data:image/webp;base64,UklGR")).toBe(true);
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
