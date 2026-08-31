// Server-only purchase verification (Node runtime — never bundled for the
// client). Proves a board ownership claim is backed by a real, CONFIRMED
// SystemProgram.transfer from the claimed owner to the treasury, so a caller
// can't write themselves (or anyone else) as an owner without actually paying.
import { Connection, PublicKey } from "@solana/web3.js";

import { getSolanaRpcEndpoint, getTreasuryPublicKey } from "@/lib/solana";

interface ParsedTransfer {
  type?: string;
  info?: { source?: string; destination?: string };
}

/**
 * Returns true when `signature` is a confirmed Solana transaction containing a
 * `SystemProgram.transfer` whose `source` is `owner` and `destination` is the
 * treasury. Anything else (missing/failed tx, wrong accounts, non-transfer)
 * returns false. Fails closed: any RPC/parse error returns false.
 */
export async function verifyTransferSignature(
  signature: string,
  owner: string
): Promise<boolean> {
  try {
    const treasury = getTreasuryPublicKey().toBase58();
    const ownerKey = new PublicKey(owner);
    const treasuryKey = new PublicKey(treasury);

    const connection = new Connection(getSolanaRpcEndpoint(), "confirmed");
    const parsed = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!parsed || parsed.meta?.err) return false;

    for (const ix of parsed.transaction.message.instructions) {
      if (!("parsed" in ix)) continue;
      const p = ix.parsed as unknown as ParsedTransfer;
      if (p?.type !== "transfer") continue;
      const source = p.info?.source;
      const destination = p.info?.destination;
      if (!source || !destination) continue;
      try {
        if (
          new PublicKey(source).equals(ownerKey) &&
          new PublicKey(destination).equals(treasuryKey)
        ) {
          return true;
        }
      } catch {
        // malformed account key — skip this instruction
      }
    }
    return false;
  } catch {
    return false;
  }
}
