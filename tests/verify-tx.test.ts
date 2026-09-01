import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { beforeEach, describe, expect, it, vi } from "vitest";

// verify-tx.ts is the server's ONLY source of truth for "did this wallet
// really pay?" — every paid action (buy, buy-area, hijack burn, buy-listing,
// rent) trusts nothing from the client except a transaction SIGNATURE, then
// independently re-derives what that signature proves by reading the chain
// itself. These tests fake the RPC layer (getServerConnection) so we can
// exhaustively exercise the verifier's accept/reject logic without a live
// network — this is exactly the "wallet-authority" proof surface the token-
// gated purchase/rent/sell flow depends on.

const getParsedTransactionMock = vi.fn();
const getMintMock = vi.fn();
// This file tests payment verification (verifySolTransfer/verifyBurn/
// verifyTokenTransfer), not the network guard — assertMainnetInProduction
// is mocked as an always-passing no-op here so those tests aren't coupled
// to it. The guard itself (including its NODE_ENV gating and real
// mainnet-vs-devnet rejection behavior) is tested end-to-end, unmocked,
// in tests/network-guard.test.ts.
const assertMainnetInProductionMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/server/rpc", () => ({
  getServerConnection: () => ({ getParsedTransaction: getParsedTransactionMock }),
  assertMainnetInProduction: assertMainnetInProductionMock,
}));

vi.mock("@solana/spl-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/spl-token")>();
  return { ...actual, getMint: (...args: unknown[]) => getMintMock(...args) };
});

const {
  verifySolTransfer,
  verifyBurn,
  verifyTokenTransfer,
  tokenAmountToRaw,
  solRequiredLamportsWithTolerance,
} = await import("../lib/server/verify-tx");

// A syntactically valid base58 Solana signature (64-100 chars, no 0/O/I/l).
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function fakeSignature(seed: number): string {
  let out = "";
  for (let i = 0; i < 88; i++) out += ALPHABET[(seed + i * 7) % ALPHABET.length];
  return out;
}

const NOW = 1_700_000_000_000;

function fakeTx(opts: {
  err?: unknown;
  blockTimeMs?: number;
  signature: string;
  instructions: unknown[];
  includeSignature?: boolean;
}) {
  return {
    meta: { err: opts.err ?? null },
    blockTime: Math.floor((opts.blockTimeMs ?? NOW) / 1000),
    transaction: {
      signatures: opts.includeSignature === false ? ["someOtherSig"] : [opts.signature],
      message: { instructions: opts.instructions },
    },
  };
}

beforeEach(() => {
  getParsedTransactionMock.mockReset();
  getMintMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("verifySolTransfer", () => {
  const payer = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey.toBase58();

  it("rejects a malformed signature without ever calling the RPC", async () => {
    const result = await verifySolTransfer({
      signature: "not-a-real-signature",
      fromOwner: payer,
      toOwner: recipient,
      minLamports: 1,
    });
    expect(result.ok).toBe(false);
    expect(getParsedTransactionMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid pubkey", async () => {
    const result = await verifySolTransfer({
      signature: fakeSignature(1),
      fromOwner: "not-a-pubkey",
      toOwner: recipient,
      minLamports: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid pubkey/);
  });

  it("rejects when the transaction is not found", async () => {
    getParsedTransactionMock.mockResolvedValue(null);
    const result = await verifySolTransfer({
      signature: fakeSignature(2),
      fromOwner: payer,
      toOwner: recipient,
      minLamports: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
  });

  it("rejects a transaction that failed on-chain", async () => {
    const sig = fakeSignature(3);
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({ signature: sig, err: { InstructionError: [0, "Custom"] }, instructions: [] })
    );
    const result = await verifySolTransfer({ signature: sig, fromOwner: payer, toOwner: recipient, minLamports: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/failed on-chain/);
  });

  it("rejects when the confirmed tx's signatures don't include the claimed one", async () => {
    const sig = fakeSignature(4);
    getParsedTransactionMock.mockResolvedValue(fakeTx({ signature: sig, instructions: [], includeSignature: false }));
    const result = await verifySolTransfer({ signature: sig, fromOwner: payer, toOwner: recipient, minLamports: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/signature mismatch/);
  });

  it("rejects a transaction older than the 15-minute freshness window", async () => {
    const sig = fakeSignature(5);
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({ signature: sig, blockTimeMs: NOW - 16 * 60_000, instructions: [] })
    );
    const result = await verifySolTransfer({ signature: sig, fromOwner: payer, toOwner: recipient, minLamports: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too old/);
  });

  it("rejects a transaction timestamped implausibly far in the future", async () => {
    const sig = fakeSignature(6);
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({ signature: sig, blockTimeMs: NOW + 5 * 60_000, instructions: [] })
    );
    const result = await verifySolTransfer({ signature: sig, fromOwner: payer, toOwner: recipient, minLamports: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/future/);
  });

  it("rejects a confirmed tx with no matching transfer instruction at all", async () => {
    const sig = fakeSignature(7);
    getParsedTransactionMock.mockResolvedValue(fakeTx({ signature: sig, instructions: [] }));
    const result = await verifySolTransfer({ signature: sig, fromOwner: payer, toOwner: recipient, minLamports: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no matching transfer/);
  });

  it("rejects a transfer to the WRONG recipient (e.g. paid someone else, not the seller/treasury)", async () => {
    const sig = fakeSignature(8);
    const wrongRecipient = Keypair.generate().publicKey.toBase58();
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [
          { program: "system", parsed: { type: "transfer", info: { source: payer, destination: wrongRecipient, lamports: 1_000_000 } } },
        ],
      })
    );
    const result = await verifySolTransfer({ signature: sig, fromOwner: payer, toOwner: recipient, minLamports: 1 });
    expect(result.ok).toBe(false);
  });

  it("rejects a transfer from the WRONG sender (someone else's payment can't be claimed)", async () => {
    const sig = fakeSignature(9);
    const wrongSender = Keypair.generate().publicKey.toBase58();
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [
          { program: "system", parsed: { type: "transfer", info: { source: wrongSender, destination: recipient, lamports: 1_000_000 } } },
        ],
      })
    );
    const result = await verifySolTransfer({ signature: sig, fromOwner: payer, toOwner: recipient, minLamports: 1 });
    expect(result.ok).toBe(false);
  });

  it("rejects a transfer for LESS than the required amount (can't underpay)", async () => {
    const sig = fakeSignature(10);
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [
          { program: "system", parsed: { type: "transfer", info: { source: payer, destination: recipient, lamports: 999 } } },
        ],
      })
    );
    const result = await verifySolTransfer({ signature: sig, fromOwner: payer, toOwner: recipient, minLamports: 1000 });
    expect(result.ok).toBe(false);
  });

  it("accepts a genuine matching transfer of at least the required amount", async () => {
    const sig = fakeSignature(11);
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [
          { program: "system", parsed: { type: "transfer", info: { source: payer, destination: recipient, lamports: 200_000_000 } } },
        ],
      })
    );
    const result = await verifySolTransfer({ signature: sig, fromOwner: payer, toOwner: recipient, minLamports: 200_000_000 });
    expect(result.ok).toBe(true);
  });

  it("accepts an overpayment (paying more than required is fine)", async () => {
    const sig = fakeSignature(12);
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [
          { program: "system", parsed: { type: "transfer", info: { source: payer, destination: recipient, lamports: 999_999_999 } } },
        ],
      })
    );
    const result = await verifySolTransfer({ signature: sig, fromOwner: payer, toOwner: recipient, minLamports: 1 });
    expect(result.ok).toBe(true);
  });

  it("finds the right transfer even among unrelated instructions in the same tx", async () => {
    const sig = fakeSignature(13);
    const noise = Keypair.generate().publicKey.toBase58();
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [
          { program: "spl-token", parsed: { type: "transfer", info: { source: noise, destination: noise } } },
          { notParsed: true },
          { program: "system", parsed: { type: "transfer", info: { source: payer, destination: recipient, lamports: 5_000 } } },
        ],
      })
    );
    const result = await verifySolTransfer({ signature: sig, fromOwner: payer, toOwner: recipient, minLamports: 5_000 });
    expect(result.ok).toBe(true);
  });
});

describe("verifyBurn", () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();

  it("accepts a matching burn of at least the required raw amount", async () => {
    const sig = fakeSignature(20);
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [{ program: "spl-token", parsed: { type: "burn", info: { mint, authority: owner, amount: "100000" } } }],
      })
    );
    const result = await verifyBurn({ signature: sig, owner, mint, minRawAmount: 100_000n });
    expect(result.ok).toBe(true);
  });

  it("also accepts the burnChecked variant", async () => {
    const sig = fakeSignature(21);
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [
          { program: "spl-token", parsed: { type: "burnChecked", info: { mint, authority: owner, tokenAmount: { amount: "50000" } } } },
        ],
      })
    );
    const result = await verifyBurn({ signature: sig, owner, mint, minRawAmount: 50_000n });
    expect(result.ok).toBe(true);
  });

  it("rejects a burn by a DIFFERENT authority (can't claim someone else's burn)", async () => {
    const sig = fakeSignature(22);
    const someoneElse = Keypair.generate().publicKey.toBase58();
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [{ program: "spl-token", parsed: { type: "burn", info: { mint, authority: someoneElse, amount: "100000" } } }],
      })
    );
    const result = await verifyBurn({ signature: sig, owner, mint, minRawAmount: 100_000n });
    expect(result.ok).toBe(false);
  });

  it("rejects a burn of the WRONG mint", async () => {
    const sig = fakeSignature(23);
    const otherMint = Keypair.generate().publicKey.toBase58();
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [{ program: "spl-token", parsed: { type: "burn", info: { mint: otherMint, authority: owner, amount: "100000" } } }],
      })
    );
    const result = await verifyBurn({ signature: sig, owner, mint, minRawAmount: 100_000n });
    expect(result.ok).toBe(false);
  });

  it("rejects a burn of an insufficient amount", async () => {
    const sig = fakeSignature(24);
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [{ program: "spl-token", parsed: { type: "burn", info: { mint, authority: owner, amount: "1" } } }],
      })
    );
    const result = await verifyBurn({ signature: sig, owner, mint, minRawAmount: 100_000n });
    expect(result.ok).toBe(false);
  });
});

describe("verifyTokenTransfer", () => {
  const fromOwner = Keypair.generate().publicKey.toBase58();
  const toOwner = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();

  function expectedAta(): string {
    return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(toOwner)).toBase58();
  }

  it("accepts a transfer that lands in the recipient's ASSOCIATED token account", async () => {
    const sig = fakeSignature(30);
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [
          {
            program: "spl-token",
            parsed: { type: "transfer", info: { mint, authority: fromOwner, destination: expectedAta(), amount: "77" } },
          },
        ],
      })
    );
    const result = await verifyTokenTransfer({ signature: sig, fromOwner, toOwner, mint, minRawAmount: 77n });
    expect(result.ok).toBe(true);
  });

  it("rejects a transfer that lands in some OTHER token account (not the recipient's ATA)", async () => {
    const sig = fakeSignature(31);
    const someRandomAccount = Keypair.generate().publicKey.toBase58();
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [
          {
            program: "spl-token",
            parsed: { type: "transfer", info: { mint, authority: fromOwner, destination: someRandomAccount, amount: "77" } },
          },
        ],
      })
    );
    const result = await verifyTokenTransfer({ signature: sig, fromOwner, toOwner, mint, minRawAmount: 77n });
    expect(result.ok).toBe(false);
  });

  it("rejects a transferChecked with insufficient amount", async () => {
    const sig = fakeSignature(32);
    getParsedTransactionMock.mockResolvedValue(
      fakeTx({
        signature: sig,
        instructions: [
          {
            program: "spl-token",
            parsed: {
              type: "transferChecked",
              info: { mint, authority: fromOwner, destination: expectedAta(), tokenAmount: { amount: "1" } },
            },
          },
        ],
      })
    );
    const result = await verifyTokenTransfer({ signature: sig, fromOwner, toOwner, mint, minRawAmount: 1000n });
    expect(result.ok).toBe(false);
  });
});

describe("tokenAmountToRaw", () => {
  it("converts a human token amount to raw units using the mint's live decimals", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    getMintMock.mockResolvedValue({ decimals: 6 });
    const raw = await tokenAmountToRaw(mint, 1.5);
    expect(raw).toBe(1_500_000n);
  });

  it("rounds UP (ceils) so the server never under-requires payment from float rounding", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    getMintMock.mockResolvedValue({ decimals: 0 });
    const raw = await tokenAmountToRaw(mint, 0.0001);
    expect(raw).toBe(1n);
  });
});

describe("solRequiredLamportsWithTolerance", () => {
  it("shaves the default 0.5% tolerance off the exact lamport amount", () => {
    const required = solRequiredLamportsWithTolerance(1); // 1 SOL = 1e9 lamports
    expect(required).toBe(Math.floor(1_000_000_000 * 0.995));
  });

  it("honors a custom tolerance fraction", () => {
    const required = solRequiredLamportsWithTolerance(1, 0.1);
    expect(required).toBe(900_000_000);
  });

  it("never requires more than the exact amount (tolerance only relaxes, never tightens)", () => {
    const exact = 200_000_000;
    const required = solRequiredLamportsWithTolerance(0.2);
    expect(required).toBeLessThanOrEqual(exact);
  });
});
