// Server-only token statistics. The single authority for the hijack burn
// tier: it reads the *cumulative burned* fraction of $PIXEL98 supply directly
// from the mint's current supply (TOTAL_SUPPLY - mint.supply = burned). This
// keeps the tier honest and on-chain-accurate once the token is live, and
// returns 0 (nothing burned yet) before launch.
import "server-only";
import { getMint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { PIXEL98_MINT } from "@/lib/solana";
import { TOTAL_SUPPLY } from "@/lib/token";
import { getServerConnection } from "./rpc";

/**
 * Cumulative burned fraction of $PIXEL98 supply, in [0, 1].
 *
 * Pre-launch (no mint set) this is 0 — nothing has been burned. Post-launch it
 * is derived from the live mint supply, so the burn tier advances automatically
 * as hijacks remove tokens from circulation (the 50/50 split means only the
 * burn half actually reduces supply; the owner half stays in circulation).
 */
export async function getBurnedFraction(): Promise<number> {
  if (!PIXEL98_MINT) return 0;

  const connection = getServerConnection();
  const mintInfo = await getMint(connection, new PublicKey(PIXEL98_MINT));
  const decimals = mintInfo.decimals;
  const totalRaw = BigInt(TOTAL_SUPPLY) * 10n ** BigInt(decimals);
  const supplyRaw = mintInfo.supply;
  const burnedRaw = totalRaw - supplyRaw;
  if (burnedRaw <= 0n) return 0;
  return Number(burnedRaw) / Number(totalRaw);
}
