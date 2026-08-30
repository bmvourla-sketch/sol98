"use client";

import { useEffect, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";

import { getSolanaRpcEndpoint } from "@/lib/solana";

/**
 * Wraps the app in Solana's wallet-adapter context and registers the PWA
 * service worker. `wallets={[]}` is intentional — wallet-adapter-react 0.15+
 * auto-detects every installed Wallet-Standard wallet (Phantom, Solflare,
 * Backpack, …) without per-wallet adapter packages. No private key ever passes
 * through this provider; every signature is produced by the extension itself.
 */
export function SolanaWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const endpoint = useMemo(() => getSolanaRpcEndpoint(), []);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // PWA offline cache is best-effort; never block the app on it.
      });
    }
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
