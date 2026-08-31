import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

// `lib/solana.ts` reads NEXT_PUBLIC_TREASURY_ADDRESS / NEXT_PUBLIC_PIXEL98_MINT
// into module-scope constants at IMPORT time (so the client bundle can inline
// them at build time). To exercise both the "unset" and "set" states in one
// test file we must reset the module registry and re-import between cases —
// mutating process.env alone would have no effect on an already-loaded module.
async function freshSolanaModule(env: Record<string, string | undefined>) {
  vi.resetModules();
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = await import("../lib/solana");
  return { mod, restore: () => Object.assign(process.env, prev) };
}

describe("isTokenLive / PIXEL98_MINT gating", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is false when NEXT_PUBLIC_PIXEL98_MINT is unset — pre-launch", async () => {
    const { mod, restore } = await freshSolanaModule({ NEXT_PUBLIC_PIXEL98_MINT: undefined });
    try {
      expect(mod.isTokenLive()).toBe(false);
      expect(mod.PIXEL98_MINT).toBe("");
    } finally {
      restore();
    }
  });

  it("is false when the mint env var is only whitespace", async () => {
    const { mod, restore } = await freshSolanaModule({ NEXT_PUBLIC_PIXEL98_MINT: "   " });
    try {
      expect(mod.isTokenLive()).toBe(false);
    } finally {
      restore();
    }
  });

  it("is true once a mint address is set — the ENTIRE post-launch gate hinges on this", async () => {
    const mint = "So11111111111111111111111111111111111111112";
    const { mod, restore } = await freshSolanaModule({ NEXT_PUBLIC_PIXEL98_MINT: mint });
    try {
      expect(mod.isTokenLive()).toBe(true);
      expect(mod.PIXEL98_MINT).toBe(mint);
    } finally {
      restore();
    }
  });
});

describe("getTreasuryPublicKey", () => {
  it("throws a clear setup error when the treasury is unset", async () => {
    const { mod, restore } = await freshSolanaModule({ NEXT_PUBLIC_TREASURY_ADDRESS: undefined });
    try {
      expect(() => mod.getTreasuryPublicKey()).toThrow(/Treasury not configured/);
    } finally {
      restore();
    }
  });

  it("throws when the treasury is still the system-program placeholder address", async () => {
    const { mod, restore } = await freshSolanaModule({
      NEXT_PUBLIC_TREASURY_ADDRESS: PublicKey.default.toBase58(),
    });
    try {
      expect(() => mod.getTreasuryPublicKey()).toThrow(/placeholder/i);
    } finally {
      restore();
    }
  });

  it("returns a real PublicKey once a real treasury address is configured", async () => {
    const real = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const { mod, restore } = await freshSolanaModule({ NEXT_PUBLIC_TREASURY_ADDRESS: real });
    try {
      const key = mod.getTreasuryPublicKey();
      expect(key.toBase58()).toBe(real);
    } finally {
      restore();
    }
  });
});

describe("getSolanaRpcEndpoint / getServerSolanaRpcEndpoint — env fallback chain", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    delete process.env.NEXT_PUBLIC_SOLANA_RPC;
    delete process.env.SOLANA_RPC_URL;
  });

  it("falls back to the mainnet default when nothing is set", async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    delete process.env.NEXT_PUBLIC_SOLANA_RPC;
    const mod = await import("../lib/solana");
    expect(mod.getSolanaRpcEndpoint()).toBe(mod.DEFAULT_MAINNET_RPC);
  });

  it("prefers NEXT_PUBLIC_SOLANA_RPC_URL over the legacy NEXT_PUBLIC_SOLANA_RPC", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL = "https://primary.example/rpc";
    process.env.NEXT_PUBLIC_SOLANA_RPC = "https://legacy.example/rpc";
    const mod = await import("../lib/solana");
    expect(mod.getSolanaRpcEndpoint()).toBe("https://primary.example/rpc");
  });

  it("uses the legacy var when only it is set", async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    process.env.NEXT_PUBLIC_SOLANA_RPC = "https://legacy-only.example/rpc";
    const mod = await import("../lib/solana");
    expect(mod.getSolanaRpcEndpoint()).toBe("https://legacy-only.example/rpc");
  });

  it("server endpoint prefers the private SOLANA_RPC_URL over the client endpoint", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL = "https://client.example/rpc";
    process.env.SOLANA_RPC_URL = "https://private-verifier.example/rpc";
    const mod = await import("../lib/solana");
    expect(mod.getServerSolanaRpcEndpoint()).toBe("https://private-verifier.example/rpc");
  });

  it("server endpoint falls back to the client endpoint when SOLANA_RPC_URL is unset", async () => {
    vi.resetModules();
    delete process.env.SOLANA_RPC_URL;
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL = "https://client-only.example/rpc";
    const mod = await import("../lib/solana");
    expect(mod.getServerSolanaRpcEndpoint()).toBe("https://client-only.example/rpc");
  });
});

describe("solToLamports / lamportsToSol", () => {
  it("round-trips exactly", async () => {
    const { solToLamports, lamportsToSol, LAMPORTS_PER_SOL } = await import("../lib/solana");
    expect(solToLamports(1)).toBe(LAMPORTS_PER_SOL);
    expect(solToLamports(0.2)).toBe(200_000_000);
    expect(lamportsToSol(200_000_000)).toBeCloseTo(0.2);
  });

  it("rounds fractional lamports (avoids float dust from SOL math)", async () => {
    const { solToLamports } = await import("../lib/solana");
    // 0.1 + 0.2 style float error must not leak into the lamport amount.
    expect(solToLamports(0.1 + 0.2)).toBe(300_000_000);
  });
});

describe("shortenAddress", () => {
  it("shortens a long address to `AbCd…WxYz`", async () => {
    const { shortenAddress } = await import("../lib/solana");
    const addr = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    expect(shortenAddress(addr)).toBe(`${addr.slice(0, 4)}…${addr.slice(-4)}`);
  });

  it("returns short addresses unchanged", async () => {
    const { shortenAddress } = await import("../lib/solana");
    expect(shortenAddress("abc")).toBe("abc");
  });

  it("returns an empty string for an empty address", async () => {
    const { shortenAddress } = await import("../lib/solana");
    expect(shortenAddress("")).toBe("");
  });

  it("honors a custom character count", async () => {
    const { shortenAddress } = await import("../lib/solana");
    const addr = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    expect(shortenAddress(addr, 6)).toBe(`${addr.slice(0, 6)}…${addr.slice(-6)}`);
  });
});
