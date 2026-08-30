// Solana configuration + pure helpers for SOL-98.
// All NEXT_PUBLIC_* values are inlined at build time and safe to expose in the
// client bundle. Every real transaction is built in `lib/purchase.ts` and
// signed/sent by the connected wallet via `lib/use-solana-tx.ts`.
import { PublicKey } from "@solana/web3.js";

export const LAMPORTS_PER_SOL = 1_000_000_000;

export const DEFAULT_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

/**
 * Treasury wallet that receives every pixel purchase (real SOL).
 * REQUIRED for live purchases — no fallback address on purpose, so a real
 * sale can never accidentally send funds to a placeholder.
 */
export const TREASURY_ADDRESS = process.env.NEXT_PUBLIC_TREASURY_ADDRESS?.trim() ?? "";

/**
 * $PIXEL98 token mint (set after the Pump.fun launch). While empty, hijack
 * burns run in simulated mode and the UI says so explicitly.
 */
export const PIXEL98_MINT = process.env.NEXT_PUBLIC_PIXEL98_MINT?.trim() ?? "";

/** True once the $PIXEL98 mint is set (post Pump.fun launch). */
export function isTokenLive(): boolean {
  return PIXEL98_MINT.length > 0;
}

export function getSolanaRpcEndpoint(): string {
  // Accept both `NEXT_PUBLIC_SOLANA_RPC_URL` (the existing payment system's
  // naming) and `NEXT_PUBLIC_SOLANA_RPC` (legacy) for a smooth merge.
  return (
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_RPC?.trim() ||
    DEFAULT_MAINNET_RPC
  );
}

/** The treasury as a `PublicKey`, throwing a clear setup error when unset. */
export function getTreasuryPublicKey(): PublicKey {
  if (!TREASURY_ADDRESS) {
    throw new Error("Treasury not configured — set NEXT_PUBLIC_TREASURY_ADDRESS");
  }
  const key = new PublicKey(TREASURY_ADDRESS);
  if (key.equals(PublicKey.default)) {
    throw new Error(
      "Treasury is still the placeholder system-program address — set a real wallet address"
    );
  }
  return key;
}

/** `AbCd…WxYz`-style shortening for wallet addresses. */
export function shortenAddress(address: string, chars = 4): string {
  if (!address) return "";
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}
