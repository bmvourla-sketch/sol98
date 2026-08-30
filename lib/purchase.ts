// Pure Solana transaction builders. These construct real, unsigned
// transactions — signing and sending happen in `lib/use-solana-tx.ts` through
// the connected wallet (wallet-adapter `sendTransaction`). No private key ever
// passes through this module.
import {
  createBurnInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import { getTreasuryPublicKey, LAMPORTS_PER_SOL } from "./solana";

/**
 * Real SOL purchase transfer: `payer` → treasury, for the bonding-curve price
 * `amountSol`. Throws if the treasury is not configured.
 */
export function buildBuyTransaction(payer: PublicKey, amountSol: number): Transaction {
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  if (!Number.isFinite(lamports) || lamports <= 0) {
    throw new Error("Invalid purchase amount");
  }
  return new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: getTreasuryPublicKey(),
      lamports,
    })
  );
}

/**
 * Real $PIXEL98 burn for a hijack: burns `amountTokens` from the payer's
 * associated token account. Only callable once the mint is live (the hook
 * `useBurnPixel98` guards this).
 */
export function buildBurnTransaction(
  payer: PublicKey,
  mint: PublicKey,
  amountTokens: number,
  decimals: number
): Transaction {
  const ata = getAssociatedTokenAddressSync(mint, payer);
  const amount = BigInt(Math.round(amountTokens * 10 ** decimals));
  if (amount <= 0n) throw new Error("Invalid burn amount");
  return new Transaction().add(createBurnInstruction(ata, mint, payer, amount));
}
