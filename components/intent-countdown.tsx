"use client";

import { useEffect, useState } from "react";

import { formatCountdown, msUntil } from "@/lib/purchase-intent";

/**
 * SOL-98 Phase 4 (GÖREV 1) — "İşlemi tamamlamak için 15 dakikanız var" UX:
 * a small live countdown shown while a purchase intent (buy-listing / rent /
 * hijack) is active and awaiting the wallet's signature, so the user knows
 * how long the server-reserved price/seller/expiry is good for.
 */
export function IntentCountdown({ expiresAt }: { expiresAt: number }) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = msUntil(expiresAt);
  const urgent = remaining < 60_000;

  if (remaining <= 0) {
    return <span className="text-[#800000]">This offer just expired — please try again.</span>;
  }

  return (
    <span className={urgent ? "text-[#800000]" : "text-[#808080]"}>
      Complete this transaction within <b>{formatCountdown(expiresAt)}</b> or it will expire.
    </span>
  );
}
