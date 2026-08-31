// Test-only stand-in for the `server-only` package. The real package throws
// unconditionally unless resolved through webpack's `react-server` export
// condition (which only Next.js's server build sets up) — under plain
// Node/Vitest it would throw on import. Vitest is aliased to this no-op so
// the server modules under test can be imported directly.
export {};
