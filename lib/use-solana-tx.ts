"use client";

import { useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getMint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { buildBurnTransaction, buildTransferTransaction } from "./purchase";
import { PIXEL98_MINT, getTreasuryPublicKey } from "./solana";
import { buildAuthMessage } from "./auth-message";
import { bytesToBase64 } from "./bytes";

export interface TxOutcome {
  signature: string;
  simulated: boolean;
}

/**
 * Sends + confirms a REAL Solana SOL transfer through the connected wallet.
 * Defaults to the treasury (pixel purchases); pass an explicit `recipient`
 * for peer-to-peer market payments (buying a listing / renting pays the
 * CURRENT OWNER, not the treasury). `onSigned` fires right after the wallet
 * signs, so the UI can flip from "awaiting signature" to "processing".
 */
export function useSendSolTransfer() {
  const { publicKey, sendTransaction, connected } = useWallet();
  const { connection } = useConnection();

  return useCallback(
    async (
      amountSol: number,
      onSigned?: (signature: string) => void,
      recipient?: PublicKey
    ): Promise<string> => {
      if (!connected || !publicKey) throw new Error("Wallet not connected");

      const tx = buildTransferTransaction(publicKey, recipient ?? getTreasuryPublicKey(), amountSol);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      // The wallet extension signs here — user approves/rejects in the popup.
      const signature = await sendTransaction(tx, connection);
      onSigned?.(signature);

      const result = await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });
      if (result.value.err) {
        throw new Error("Transaction failed on-chain");
      }
      return signature;
    },
    [publicKey, sendTransaction, connection, connected]
  );
}

/**
 * Sends + confirms a $PIXEL98 burn (hijack). While `NEXT_PUBLIC_PIXEL98_MINT`
 * is unset (token not live), falls back to a SIMULATED burn and marks the
 * outcome `simulated: true` so the UI can say so. The API still requires a
 * signed auth message for the simulated path (see `useSignAuthMessage`), so
 * a hijack can never be forged by a bare unauthenticated POST.
 */
export function useBurnPixel98() {
  const { publicKey, sendTransaction, connected } = useWallet();
  const { connection } = useConnection();

  return useCallback(
    async (amountTokens: number, onSigned?: (signature: string) => void): Promise<TxOutcome> => {
      if (!connected || !publicKey) throw new Error("Wallet not connected");

      if (!PIXEL98_MINT) {
        // $PIXEL98 not live yet — simulated burn, clearly flagged. The server
        // still requires a fresh signed auth message for this path.
        await new Promise((resolve) => setTimeout(resolve, 600));
        return { signature: `simulated-${Date.now().toString(16)}`, simulated: true };
      }

      const mint = new PublicKey(PIXEL98_MINT);
      const mintInfo = await getMint(connection, mint);
      const tx = buildBurnTransaction(publicKey, mint, amountTokens, mintInfo.decimals);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signature = await sendTransaction(tx, connection);
      onSigned?.(signature);

      const result = await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });
      if (result.value.err) {
        throw new Error("Burn failed on-chain");
      }
      return { signature, simulated: false };
    },
    [publicKey, sendTransaction, connection, connected]
  );
}

export interface AuthProof {
  actor: string;
  timestamp: number;
  signature: string; // base64
}

/**
 * Signs the free-actions auth message (edit / list / unlist / simulated
 * hijack) with the connected wallet's `signMessage` — NO transaction, no
 * fee, no funds move. The API re-derives the same message and verifies the
 * signature with the claimed owner's public key, so nobody can POST changes
 * to a pixel they don't control just by naming themselves the owner.
 */
export function useSignAuthMessage() {
  const { publicKey, signMessage, connected } = useWallet();

  return useCallback(
    async (action: string, index: number | number[]): Promise<AuthProof> => {
      if (!connected || !publicKey) throw new Error("Wallet not connected");
      if (!signMessage) {
        throw new Error("This wallet doesn't support message signing (try Phantom or Solflare).");
      }
      const timestamp = Date.now();
      const actor = publicKey.toBase58();
      const message = buildAuthMessage(action, index, actor, timestamp);
      const signatureBytes = await signMessage(new TextEncoder().encode(message));
      return { actor, timestamp, signature: bytesToBase64(signatureBytes) };
    },
    [publicKey, signMessage, connected]
  );
}
