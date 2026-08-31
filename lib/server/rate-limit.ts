// Best-effort in-memory rate limiting. This resets on every cold start and
// does not span multiple serverless instances — it raises the bar against a
// casual scripted flood, it is not a substitute for the on-chain / signed-
// message proofs the API now requires on every write. Document this
// limitation; a production deploy under real load should move this to a
// shared store (Upstash Redis, Vercel KV, etc).
import "server-only";

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

// Periodically forget stale buckets so this map can't grow unboundedly.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweep = Date.now();

function sweep(now: number, windowMs: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > windowMs) buckets.delete(key);
  }
}

/** Fixed-window limiter. Returns true if `key` is currently allowed. */
export function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now, windowMs);
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart > windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

export function requestIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
