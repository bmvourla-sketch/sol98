import { describe, expect, it } from "vitest";

import { isRateLimited } from "../lib/server/rate-limit";

describe("isRateLimited", () => {
  it("allows up to `limit` requests in the window, then blocks", () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 3; i++) {
      expect(isRateLimited(key, 3, 60_000)).toBe(false);
    }
    // 4th request exceeds the limit of 3.
    expect(isRateLimited(key, 3, 60_000)).toBe(true);
  });

  it("tracks separate keys independently", () => {
    const a = `test-a-${Math.random()}`;
    const b = `test-b-${Math.random()}`;
    for (let i = 0; i < 5; i++) isRateLimited(a, 5, 60_000);
    // `a` is now exhausted, but `b` should be fresh.
    expect(isRateLimited(b, 5, 60_000)).toBe(false);
  });
});
