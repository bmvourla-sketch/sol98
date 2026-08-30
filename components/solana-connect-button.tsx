"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ChevronDown, Wallet } from "lucide-react";

import { shortenAddress } from "@/lib/solana";

/**
 * Win98-styled Solana wallet connect control. Selecting a wallet from the
 * dropdown sets a `pendingConnect` flag; a useEffect then calls `connect()`
 * only AFTER the selection has propagated to `wallet` — this avoids the
 * classic `WalletNotSelectedError` race (connect before select settles).
 */
export function SolanaConnectButton() {
  const {
    wallets,
    publicKey,
    connected,
    connecting,
    disconnecting,
    select,
    connect,
    disconnect,
    wallet,
  } = useWallet();

  const [open, setOpen] = useState(false);
  const [pendingConnect, setPendingConnect] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Connect only after the selected wallet has propagated to `wallet`.
  useEffect(() => {
    if (pendingConnect && wallet && !connected) {
      setPendingConnect(false);
      connect().catch(() => {});
    }
  }, [pendingConnect, wallet, connected, connect]);

  const label = connected && publicKey ? shortenAddress(publicKey.toBase58()) : "Connect Wallet";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="win98-button flex items-center gap-1 !px-2 !py-[2px] text-[11px]"
        onClick={() => {
          if (connected) {
            disconnect().catch(() => {});
          } else {
            setOpen((o) => !o);
          }
        }}
      >
        <Wallet size={12} />
        <span>{connecting ? "Connecting…" : disconnecting ? "…" : label}</span>
        {!connected && <ChevronDown size={11} />}
      </button>

      {open && !connected && (
        <div className="win98-menu absolute top-full right-0 mt-1 w-56 py-1">
          {wallets.length === 0 && (
            <div className="px-3 py-2 text-[11px] leading-snug">
              No wallet detected.
              <br />
              Install Phantom or Solflare.
            </div>
          )}
          {wallets.map((w) => (
            <button
              key={w.adapter.name}
              type="button"
              className="win98-menu-item w-full text-left"
              onClick={() => {
                setOpen(false);
                setPendingConnect(true);
                select(w.adapter.name);
              }}
            >
              <Wallet size={14} />
              {w.adapter.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
