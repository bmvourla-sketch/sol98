"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { ChevronDown } from "lucide-react";

import { shortenAddress } from "@/lib/solana";

/**
 * Win98-styled wallet logo. Wallet-Standard adapters ship their own icon as a
 * base64 data URI (`adapter.icon`) — we render that directly, falling back to
 * the wallet's initial when an adapter omits it.
 */
function WalletLogo({
  icon,
  name,
  size = 16,
}: {
  icon?: string;
  name: string;
  size?: number;
}) {
  if (icon) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={icon}
        alt={`${name} logo`}
        width={size}
        height={size}
        className="shrink-0"
        style={{ objectFit: "contain" }}
      />
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center bg-white font-bold text-[#000080]"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Win98-styled Solana wallet connect control.
 *
 * Connection reliability fixes over the naive "select then connect" flow:
 *  - Installed wallets are listed first; `NotDetected` wallets open their
 *    install page instead of attempting a doomed `connect()`.
 *  - `select()` is wrapped in try/catch, and the deferred `connect()` is
 *    guarded by `readyState` so an unsupported/undetected adapter can't fire
 *    a silent WalletNotSelectedError.
 *  - Connection errors are surfaced in the dropdown instead of being swallowed.
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
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close the menu on outside click.
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

  // Installed first, then Loadable, then the rest (alphabetical within a rank).
  const ordered = useMemo(() => {
    const rank = (s: WalletReadyState) =>
      s === WalletReadyState.Installed ? 0 : s === WalletReadyState.Loadable ? 1 : 2;
    return [...wallets].sort(
      (a, b) =>
        rank(a.readyState) - rank(b.readyState) ||
        a.adapter.name.localeCompare(b.adapter.name)
    );
  }, [wallets]);

  // Connect only after the selected wallet has propagated to `wallet` — this
  // avoids the classic WalletNotSelectedError race (connect before the select
  // settles). Guarded by readyState so we never try to connect a wallet that
  // isn't actually available.
  useEffect(() => {
    if (!pendingConnect || !wallet) return;
    setPendingConnect(false);
    const ready = wallet.readyState;
    if (ready !== WalletReadyState.Installed && ready !== WalletReadyState.Loadable) {
      setError(`${wallet.adapter.name} is not installed.`);
      return;
    }
    setError(null);
    connect().catch((e) => {
      setError(e instanceof Error ? e.message : "Connection failed — try again.");
    });
  }, [pendingConnect, wallet, connect]);

  function handleWalletClick(w: (typeof ordered)[number]) {
    setOpen(false);
    setError(null);
    if (w.readyState === WalletReadyState.NotDetected) {
      window.open(w.adapter.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (w.readyState === WalletReadyState.Unsupported) {
      setError(`${w.adapter.name} is not supported on this device.`);
      return;
    }
    try {
      select(w.adapter.name);
      setPendingConnect(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not select wallet.");
    }
  }

  const label =
    connected && publicKey ? shortenAddress(publicKey.toBase58()) : "Connect Wallet";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="win98-button flex items-center gap-1 !px-2 !py-[2px] text-[11px]"
        onClick={() => {
          setError(null);
          if (connected) {
            disconnect().catch(() => {});
          } else {
            setOpen((o) => !o);
          }
        }}
      >
        {wallet ? (
          <WalletLogo icon={wallet.adapter.icon} name={wallet.adapter.name} size={14} />
        ) : (
          <span className="bevel-out-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center bg-white text-[9px] font-bold text-[#000080]">
            $
          </span>
        )}
        <span className="whitespace-nowrap">
          {connecting ? "Connecting…" : disconnecting ? "…" : label}
        </span>
        {!connected && <ChevronDown size={11} />}
      </button>

      {open && !connected && (
        <div className="win98-menu absolute right-0 top-full z-50 mt-1 w-60 py-1">
          {ordered.length === 0 && (
            <div className="px-3 py-2 text-[11px] leading-snug text-[#000]">
              No wallet detected.
              <br />
              Install Phantom or Solflare, then refresh.
            </div>
          )}

          {error && (
            <div className="bevel-in mx-2 mb-1 px-2 py-1 text-[11px] leading-snug text-[#800000]">
              {error}
            </div>
          )}

          {ordered.map((w) => {
            const notInstalled = w.readyState === WalletReadyState.NotDetected;
            const unsupported = w.readyState === WalletReadyState.Unsupported;
            return (
              <button
                key={w.adapter.name}
                type="button"
                className="win98-menu-item w-full text-left text-[11px]"
                onClick={() => handleWalletClick(w)}
              >
                <span className="bevel-in flex h-6 w-6 shrink-0 items-center justify-center bg-white p-[2px]">
                  <WalletLogo icon={w.adapter.icon} name={w.adapter.name} size={20} />
                </span>
                <span className="flex-1 truncate">{w.adapter.name}</span>
                {notInstalled && <span className="text-[10px] text-[#808080]">Install</span>}
                {unsupported && <span className="text-[10px] text-[#808080]">N/A</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
