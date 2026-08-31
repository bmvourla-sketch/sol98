import { describe, expect, it } from "vitest";

import { createMutex } from "../lib/server/mutex";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createMutex", () => {
  it("serializes concurrent calls — no interleaving inside a locked section", async () => {
    const withLock = createMutex();
    const order: string[] = [];

    async function critical(label: string, workMs: number) {
      return withLock(async () => {
        order.push(`${label}:start`);
        await delay(workMs);
        order.push(`${label}:end`);
      });
    }

    // Fire three overlapping calls; the slow one goes first so a broken
    // (non-serializing) implementation would interleave B/C into it.
    await Promise.all([critical("A", 30), critical("B", 5), critical("C", 5)]);

    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end", "C:start", "C:end"]);
  });

  it("propagates a rejection without wedging the queue for later calls", async () => {
    const withLock = createMutex();
    await expect(
      withLock(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // The queue must still be usable after a failure.
    const result = await withLock(async () => "ok");
    expect(result).toBe("ok");
  });
});
