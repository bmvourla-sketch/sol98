"use client";

import { useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getMint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { buildBurnTransaction, buildBuyTransaction } from "./purchase";
import { PIXEL98_MINT } from "./solana";

export interface TxOutcome {
  signature: string;
  simulated: boolean;
}

/**
 * Sends + confirms a REAL Solana purchase (buy) through the connected wallet.
 * `onSigned` fires right after the wallet signs, so the UI can flip from
 * "awaiting signature" to "processing/confirming".
 */
export function useSendSolTransfer() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  return useCallback(
    async (amountSol: number, onSigned?: (signature: string) => void): Promise<string> => {
      if (!publicKey || !sendTransaction) throw new Error("Wallet not connected");

      const tx = buildBuyTransaction(publicKey, amountSol);
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
    [publicKey, sendTransaction, connection]
  );
}

/**
 * Sends + confirms a $PIXEL98 burn (hijack). While `NEXT_PUBLIC_PIXEL98_MINT`
 * is unset (token not live), falls back to a SIMULATED burn and marks the
 * outcome `simulated: true` so the UI can say so.
 */
export function useBurnPixel98() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  return useCallback(
    async (amountTokens: number, onSigned?: (signature: string) => void): Promise<TxOutcome> => {
      if (!publicKey || !sendTransaction) throw new Error("Wallet not connected");

      if (!PIXEL98_MINT) {
        // $PIXEL98 not live yet — simulated burn, clearly flagged.
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
    [publicKey, sendTransaction, connection]
  );
}
