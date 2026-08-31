// Tiny async mutex: serializes read-check-write critical sections within
// ONE Node process. This is what makes "buy" atomic against a race of two
// people buying the same empty index at the same instant on the file-store
// (single-machine) deploy. It does NOT span multiple serverless instances —
// the Supabase backend gets its real atomicity from Postgres constraints
// (primary key on `pixels.index`, conditional UPDATE ... WHERE owner = X)
// instead, see lib/server/pixel-db-supabase.ts.
import "server-only";

export function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();

  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    // Swallow errors here so one failed call doesn't wedge the queue for
    // everyone after it — the real rejection still propagates via `run`.
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}
