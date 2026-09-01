// Server-only Solana RPC connection, used to independently VERIFY that a
// transaction the client claims to have sent actually landed on-chain and
// does what it says. Never trust a client-submitted signature without this.
import "server-only";
import { Connection } from "@solana/web3.js";

import { getServerSolanaRpcEndpoint } from "@/lib/solana";

let cached: Connection | null = null;

export function getServerConnection(): Connection {
  if (!cached) {
    cached = new Connection(getServerSolanaRpcEndpoint(), "confirmed");
  }
  return cached;
}

// Solana mainnet-beta's genesis hash — fixed and public for a live network,
// unlike the RPC URL string (server-configured via SOLANA_RPC_URL /
// NEXT_PUBLIC_SOLANA_RPC_URL, which could be silently misconfigured to
// devnet/testnet by mistake). Source: cross-referenced against Solana RPC
// docs (getGenesisHash) and Chainlink's chain-selectors registry.
export const MAINNET_BETA_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

let mainnetChecked = false;

/**
 * Production-only defense in depth (SOL-98 Phase 2, red-team §9 "network
 * mismatch"): confirms the server's RPC endpoint is ACTUALLY mainnet-beta by
 * its genesis hash — never by trusting the configured URL string. Without
 * this, a misconfigured `SOLANA_RPC_URL` pointing at devnet would silently
 * "verify" devnet transactions as real payments: `verifySolTransfer` /
 * `verifyBurn` / `verifyTokenTransfer` (verify-tx.ts) only check that a
 * *confirmed* transaction on WHATEVER network the RPC connects to matches
 * the expected amount/sender/recipient — they have no independent way to
 * know that network is mainnet unless told. This closes that gap.
 *
 * Cached after the first successful check per process (a live network's
 * genesis hash never changes), so this costs one extra RPC call per cold
 * start, not per request. No-op outside production (`NODE_ENV !==
 * "production"`) so local dev/test against devnet is unaffected — mirrors
 * `requireDurableStore()`'s gating pattern (lib/server/supabase-env.ts).
 */
export async function assertMainnetInProduction(): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  if (mainnetChecked) return;
  const hash = await getServerConnection().getGenesisHash();
  if (hash !== MAINNET_BETA_GENESIS_HASH) {
    throw new Error(
      `refusing to verify payments: server RPC is not mainnet-beta (genesis hash "${hash}") — check SOLANA_RPC_URL`
    );
  }
  mainnetChecked = true;
}

/** Test-only: clears the cached mainnet-check result between test cases. */
export function __resetMainnetCheckForTests(): void {
  mainnetChecked = false;
}
