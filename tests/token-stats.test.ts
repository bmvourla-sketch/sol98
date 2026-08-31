import { afterEach, describe, expect, it, vi } from "vitest";

// getBurnedFraction() is the single authority the hijack burn tier is priced
// from (see lib/server/token-stats.ts) — pre-launch it must return exactly 0
// without ever touching the network (no mint configured yet); post-launch it
// must derive the burned fraction from the mint's LIVE on-chain supply.
// We mock @solana/spl-token's getMint and lib/server/rpc's getServerConnection
// so this never makes a real RPC call.

const getMintMock = vi.fn();

vi.mock("@solana/spl-token", () => ({
  getMint: (...args: unknown[]) => getMintMock(...args),
}));

vi.mock("../lib/server/rpc", () => ({
  getServerConnection: () => ({ __fakeConnection: true }),
}));

async function freshTokenStats(mintEnv: string | undefined) {
  vi.resetModules();
  getMintMock.mockReset();
  const prev = process.env.NEXT_PUBLIC_PIXEL98_MINT;
  if (mintEnv === undefined) delete process.env.NEXT_PUBLIC_PIXEL98_MINT;
  else process.env.NEXT_PUBLIC_PIXEL98_MINT = mintEnv;
  const mod = await import("../lib/server/token-stats");
  return {
    mod,
    restore: () => {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_PIXEL98_MINT;
      else process.env.NEXT_PUBLIC_PIXEL98_MINT = prev;
    },
  };
}

describe("getBurnedFraction — pre-launch", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns 0 and never calls the RPC when no mint is configured", async () => {
    const { mod, restore } = await freshTokenStats(undefined);
    try {
      const fraction = await mod.getBurnedFraction();
      expect(fraction).toBe(0);
      expect(getMintMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("getBurnedFraction — post-launch (live mint)", () => {
  const MINT = "So11111111111111111111111111111111111111112";

  afterEach(() => vi.unstubAllEnvs());

  it("derives burned fraction from TOTAL_SUPPLY minus the live mint supply", async () => {
    const { mod, restore } = await freshTokenStats(MINT);
    try {
      const { TOTAL_SUPPLY } = await import("../lib/token");
      const decimals = 6;
      const totalRaw = BigInt(TOTAL_SUPPLY) * 10n ** BigInt(decimals);
      // 25% burned: supply on-chain is 75% of the total.
      const supplyRaw = (totalRaw * 75n) / 100n;
      getMintMock.mockResolvedValue({ decimals, supply: supplyRaw });

      const fraction = await mod.getBurnedFraction();
      expect(fraction).toBeCloseTo(0.25, 6);
      expect(getMintMock).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("returns 0 when nothing has been burned yet (full supply still circulating)", async () => {
    const { mod, restore } = await freshTokenStats(MINT);
    try {
      const { TOTAL_SUPPLY } = await import("../lib/token");
      const decimals = 9;
      const totalRaw = BigInt(TOTAL_SUPPLY) * 10n ** BigInt(decimals);
      getMintMock.mockResolvedValue({ decimals, supply: totalRaw });

      const fraction = await mod.getBurnedFraction();
      expect(fraction).toBe(0);
    } finally {
      restore();
    }
  });

  it("clamps to 0 rather than going negative if on-chain supply somehow exceeds TOTAL_SUPPLY", async () => {
    const { mod, restore } = await freshTokenStats(MINT);
    try {
      const { TOTAL_SUPPLY } = await import("../lib/token");
      const decimals = 0;
      const totalRaw = BigInt(TOTAL_SUPPLY);
      getMintMock.mockResolvedValue({ decimals, supply: totalRaw + 1_000n });

      const fraction = await mod.getBurnedFraction();
      expect(fraction).toBe(0);
    } finally {
      restore();
    }
  });
});
