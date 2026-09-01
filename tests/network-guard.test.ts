// SOL-98 Phase 2 — red-team §9 "network mismatch".
//
// Phase 0/1 never asserted anywhere that the server's Solana RPC connection
// is actually mainnet-beta. verify-tx.ts's checks (amount/sender/recipient/
// success) all pass equally well against a *confirmed* transaction on ANY
// network the RPC happens to be pointed at — including devnet, where SOL is
// free. If `SOLANA_RPC_URL` (or its `NEXT_PUBLIC_SOLANA_RPC_URL` fallback,
// see lib/solana.ts `getServerSolanaRpcEndpoint`) were ever misconfigured to
// devnet in production, a "payment" of devnet SOL would verify as real.
//
// lib/server/rpc.ts now exports `assertMainnetInProduction()`, which checks
// the connection's genesis hash against the known mainnet-beta value. This
// file tests THAT function directly and unmocked (only the underlying
// `@solana/web3.js` Connection class is mocked, at the constructor level —
// not lib/server/rpc.ts itself), so the real NODE_ENV gating and comparison
// logic run for real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getGenesisHashMock = vi.fn();

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    // A regular `function`, not an arrow function: `new Connection(...)` in
    // rpc.ts invokes this as a constructor, and vi.fn()'s mock implementation
    // must itself be constructible (via Reflect.construct) for that to work —
    // an arrow function throws "is not a constructor" the moment `new` hits it.
    Connection: vi.fn().mockImplementation(function () {
      return { getGenesisHash: getGenesisHashMock };
    }),
  };
});

const MAINNET_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"; // a different, syntactically plausible hash — not asserting devnet's real value, only that it's NOT the mainnet one

describe("assertMainnetInProduction — network mismatch guard", () => {
  beforeEach(() => {
    vi.resetModules();
    getGenesisHashMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a NO-OP outside production (dev/test) — never calls the RPC at all", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const { assertMainnetInProduction } = await import("../lib/server/rpc");
    await expect(assertMainnetInProduction()).resolves.toBeUndefined();
    expect(getGenesisHashMock).not.toHaveBeenCalled();
  });

  it("PRODUCTION + mainnet-beta genesis hash → passes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getGenesisHashMock.mockResolvedValue(MAINNET_HASH);
    const { assertMainnetInProduction } = await import("../lib/server/rpc");
    await expect(assertMainnetInProduction()).resolves.toBeUndefined();
  });

  it("PRODUCTION + a DIFFERENT (e.g. devnet) genesis hash → REJECTS — this is the actual exploit this guard closes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getGenesisHashMock.mockResolvedValue(DEVNET_HASH);
    const { assertMainnetInProduction } = await import("../lib/server/rpc");
    await expect(assertMainnetInProduction()).rejects.toThrow(/not mainnet-beta/);
  });

  it("PRODUCTION + empty/undefined genesis hash (RPC misbehaving) → REJECTS, does not fail open", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getGenesisHashMock.mockResolvedValue("");
    const { assertMainnetInProduction } = await import("../lib/server/rpc");
    await expect(assertMainnetInProduction()).rejects.toThrow(/not mainnet-beta/);
  });

  it("caches the result — a second call in the same process does NOT re-hit the RPC", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getGenesisHashMock.mockResolvedValue(MAINNET_HASH);
    const { assertMainnetInProduction } = await import("../lib/server/rpc");
    await assertMainnetInProduction();
    await assertMainnetInProduction();
    await assertMainnetInProduction();
    expect(getGenesisHashMock).toHaveBeenCalledTimes(1);
  });

  it("a REJECTED check is not cached as success — a persistently-devnet RPC keeps failing on every call", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getGenesisHashMock.mockResolvedValue(DEVNET_HASH);
    const { assertMainnetInProduction } = await import("../lib/server/rpc");
    await expect(assertMainnetInProduction()).rejects.toThrow();
    await expect(assertMainnetInProduction()).rejects.toThrow();
    expect(getGenesisHashMock).toHaveBeenCalledTimes(2);
  });
});

describe("verify-tx.ts fetchConfirmedTx wires the network guard in front of EVERY chain read", () => {
  beforeEach(() => {
    vi.resetModules();
    getGenesisHashMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("PRODUCTION + devnet RPC → verifySolTransfer rejects BEFORE ever calling getParsedTransaction (fails closed, not just eventually)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getGenesisHashMock.mockResolvedValue(DEVNET_HASH);
    const getParsedTransactionMock = vi.fn().mockResolvedValue({
      meta: { err: null },
      blockTime: Math.floor(Date.now() / 1000),
      transaction: { signatures: ["x"], message: { instructions: [] } },
    });
    // Patch the mocked Connection to also expose getParsedTransaction, since
    // this test exercises the real getServerConnection() → real Connection
    // mock → real fetchConfirmedTx path end to end.
    const web3 = await import("@solana/web3.js");
    (web3.Connection as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return { getGenesisHash: getGenesisHashMock, getParsedTransaction: getParsedTransactionMock };
    });

    const { verifySolTransfer } = await import("../lib/server/verify-tx");
    const { Keypair } = await import("@solana/web3.js");
    const payer = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();
    // A syntactically valid-looking signature so we get past the regex check
    // and prove the network guard — not signature format — is what rejects.
    const sig = "1".repeat(88).replace(/1/g, (_, i) => "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[i % 58]);

    const result = await verifySolTransfer({ signature: sig, fromOwner: payer, toOwner: recipient, minLamports: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not mainnet-beta/);
    expect(getParsedTransactionMock).not.toHaveBeenCalled();
  });
});
