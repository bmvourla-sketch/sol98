// Independently verifies that a client-submitted transaction SIGNATURE
// really is a confirmed on-chain transaction that does what the client
// claims (pays the treasury / pays a specific owner / burns $PIXEL98) —
// this is the whole point of the redesign: the API never again trusts a
// bare `{index, owner}` POST, it trusts on-chain state it reads itself.
import "server-only";
import type { ParsedInstruction, PartiallyDecodedInstruction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";

import { assertMainnetInProduction, getServerConnection } from "./rpc";
import { solToLamports } from "@/lib/solana";

const MAX_TX_AGE_MS = 15 * 60 * 1000; // 15 minutes — bounds (doesn't replace) replay risk
const MAX_TX_FUTURE_SKEW_MS = 2 * 60 * 1000;

export type VerifyResult = { ok: true } | { ok: false; error: string };

function isParsedInstruction(
  ix: ParsedInstruction | PartiallyDecodedInstruction
): ix is ParsedInstruction {
  return "parsed" in ix;
}

function normalizePubkey(value: string): string | null {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

/**
 * Fetches a confirmed transaction and runs the shared sanity checks every
 * verifier needs: it exists, it succeeded, it's recent, and its signatures
 * actually include the claimed one.
 */
async function fetchConfirmedTx(signature: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(signature)) {
    return { ok: false as const, error: "malformed signature" };
  }
  try {
    await assertMainnetInProduction();
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "network verification failed" };
  }
  const connection = getServerConnection();
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) return { ok: false as const, error: "transaction not found (not confirmed yet?)" };
  if (tx.meta?.err) return { ok: false as const, error: "transaction failed on-chain" };
  if (!tx.transaction.signatures.includes(signature)) {
    return { ok: false as const, error: "signature mismatch" };
  }
  const blockTimeMs = (tx.blockTime ?? 0) * 1000;
  const now = Date.now();
  if (!blockTimeMs || now - blockTimeMs > MAX_TX_AGE_MS) {
    return { ok: false as const, error: "transaction too old — please retry with a fresh one" };
  }
  if (blockTimeMs - now > MAX_TX_FUTURE_SKEW_MS) {
    return { ok: false as const, error: "transaction timestamp is in the future" };
  }
  return { ok: true as const, tx };
}

export interface TransferCheck {
  signature: string;
  fromOwner: string;
  toOwner: string;
  minLamports: number;
}

/** Verifies a confirmed SystemProgram transfer `fromOwner` → `toOwner` of at least `minLamports`. */
export async function verifySolTransfer({
  signature,
  fromOwner,
  toOwner,
  minLamports,
}: TransferCheck): Promise<VerifyResult> {
  const from = normalizePubkey(fromOwner);
  const to = normalizePubkey(toOwner);
  if (!from || !to) return { ok: false, error: "invalid pubkey" };

  const fetched = await fetchConfirmedTx(signature);
  if (!fetched.ok) return fetched;

  const instructions = fetched.tx.transaction.message.instructions;
  for (const ix of instructions) {
    if (!isParsedInstruction(ix)) continue;
    if (ix.program !== "system" || ix.parsed?.type !== "transfer") continue;
    const info = ix.parsed.info as { source?: string; destination?: string; lamports?: number };
    if (!info.source || !info.destination) continue;
    const source = normalizePubkey(info.source);
    const destination = normalizePubkey(info.destination);
    const lamports = Number(info.lamports ?? 0);
    if (source === from && destination === to && lamports >= minLamports) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    error: `no matching transfer of >= ${minLamports} lamports from ${fromOwner} to ${toOwner} found in that transaction`,
  };
}

export interface BurnCheck {
  signature: string;
  owner: string; // burn authority
  mint: string;
  minRawAmount: bigint;
}

/** Verifies a confirmed SPL `burn`/`burnChecked` of at least `minRawAmount` (raw, pre-decimals) by `owner`. */
export async function verifyBurn({
  signature,
  owner,
  mint,
  minRawAmount,
}: BurnCheck): Promise<VerifyResult> {
  const authority = normalizePubkey(owner);
  const mintKey = normalizePubkey(mint);
  if (!authority || !mintKey) return { ok: false, error: "invalid pubkey" };

  const fetched = await fetchConfirmedTx(signature);
  if (!fetched.ok) return fetched;

  const instructions = fetched.tx.transaction.message.instructions;
  for (const ix of instructions) {
    if (!isParsedInstruction(ix)) continue;
    if (ix.program !== "spl-token") continue;
    if (ix.parsed?.type !== "burn" && ix.parsed?.type !== "burnChecked") continue;
    const info = ix.parsed.info as {
      mint?: string;
      authority?: string;
      amount?: string;
      tokenAmount?: { amount: string };
    };
    const ixMint = info.mint ? normalizePubkey(info.mint) : null;
    const ixAuthority = info.authority ? normalizePubkey(info.authority) : null;
    const rawAmountStr = info.amount ?? info.tokenAmount?.amount;
    if (!ixMint || !ixAuthority || !rawAmountStr) continue;
    let rawAmount: bigint;
    try {
      rawAmount = BigInt(rawAmountStr);
    } catch {
      continue;
    }
    if (ixMint === mintKey && ixAuthority === authority && rawAmount >= minRawAmount) {
      return { ok: true };
    }
  }
  return { ok: false, error: "no matching $PIXEL98 burn found in that transaction" };
}

export interface TokenTransferCheck {
  signature: string;
  fromOwner: string; // payer / source-token-account authority
  toOwner: string; // recipient wallet (destination ATA is derived)
  mint: string;
  minRawAmount: bigint;
}

/**
 * Verifies a confirmed SPL `transfer`/`transferChecked` of at least
 * `minRawAmount` (raw, pre-decimals) from `fromOwner`'s token account to
 * `toOwner`'s associated token account. Used for the hijack's 50/50 split
 * (the owner-compensation half) and for $PIXEL98-denominated market payments.
 */
export async function verifyTokenTransfer({
  signature,
  fromOwner,
  toOwner,
  mint,
  minRawAmount,
}: TokenTransferCheck): Promise<VerifyResult> {
  const authority = normalizePubkey(fromOwner);
  const recipient = normalizePubkey(toOwner);
  const mintKey = normalizePubkey(mint);
  if (!authority || !recipient || !mintKey) return { ok: false, error: "invalid pubkey" };

  const expectedDest = getAssociatedTokenAddressSync(
    new PublicKey(mintKey),
    new PublicKey(recipient)
  ).toBase58();

  const fetched = await fetchConfirmedTx(signature);
  if (!fetched.ok) return fetched;

  const instructions = fetched.tx.transaction.message.instructions;
  for (const ix of instructions) {
    if (!isParsedInstruction(ix)) continue;
    if (ix.program !== "spl-token") continue;
    if (ix.parsed?.type !== "transfer" && ix.parsed?.type !== "transferChecked") continue;
    const info = ix.parsed.info as {
      mint?: string;
      authority?: string;
      destination?: string;
      amount?: string;
      tokenAmount?: { amount: string };
    };
    const ixMint = info.mint ? normalizePubkey(info.mint) : null;
    const ixAuthority = info.authority ? normalizePubkey(info.authority) : null;
    const ixDest = info.destination ? normalizePubkey(info.destination) : null;
    const rawAmountStr = info.amount ?? info.tokenAmount?.amount;
    if (!ixMint || !ixAuthority || !ixDest || !rawAmountStr) continue;
    let rawAmount: bigint;
    try {
      rawAmount = BigInt(rawAmountStr);
    } catch {
      continue;
    }
    if (
      ixMint === mintKey &&
      ixAuthority === authority &&
      ixDest === expectedDest &&
      rawAmount >= minRawAmount
    ) {
      return { ok: true };
    }
  }
  return { ok: false, error: "no matching $PIXEL98 transfer to the owner found in that transaction" };
}

/** Converts a human token amount to its raw (pre-decimals) integer form using the mint's live decimals. */
export async function tokenAmountToRaw(mint: string, amountTokens: number): Promise<bigint> {
  const connection = getServerConnection();
  const mintInfo = await getMint(connection, new PublicKey(mint));
  return BigInt(Math.ceil(amountTokens * 10 ** mintInfo.decimals));
}

export function solRequiredLamportsWithTolerance(amountSol: number, toleranceFraction = 0.005): number {
  const exact = solToLamports(amountSol);
  return Math.floor(exact * (1 - toleranceFraction));
}
