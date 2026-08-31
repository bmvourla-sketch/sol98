// Canonical message format for "prove you control this wallet" actions that
// don't need an on-chain transaction (edit ad, list/unlist, list for rent).
// Both the browser (signs it with wallet.signMessage) and the API route
// (re-derives the exact same string and verifies the signature against it
// with tweetnacl) import this — so it must stay pure/framework-free.

export const AUTH_MESSAGE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
export const AUTH_MESSAGE_MAX_SKEW_MS = 60 * 1000; // 1 minute of clock drift, forward

export function buildAuthMessage(
  action: string,
  index: number | number[],
  owner: string,
  timestamp: number
): string {
  const indexPart = Array.isArray(index) ? index.join(",") : String(index);
  return [
    "SOL-98 auth request — signing this proves wallet ownership, no funds move.",
    `action:${action}`,
    `index:${indexPart}`,
    `owner:${owner}`,
    `ts:${timestamp}`,
  ].join("\n");
}

/** `now` is injectable for tests; defaults to the real clock. */
export function isAuthTimestampFresh(timestamp: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(timestamp)) return false;
  if (timestamp > now + AUTH_MESSAGE_MAX_SKEW_MS) return false; // from the future
  if (now - timestamp > AUTH_MESSAGE_MAX_AGE_MS) return false; // stale
  return true;
}
