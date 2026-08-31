const ROADMAP = `SOL-98 — ROADMAP.EXE
================================================================================

PHASE 1 — BOOT SEQUENCE   [SHIPPED]
    [x] Board live (100×100 blocks · 1,000,000 px)
    [x] 0.2 SOL sales (10×10 blocks, +10% bonding curve)
    [x] Wallet connect (Phantom / Solflare) — top-right
    [x] Market.exe — buy / rent / sell blocks
    [x] Banner.exe — banner studio (upload + optimize + download + place)
    [x] Neon templates (Cyberpunk / Matrix / Flashing / Glitch / Rainbow)
    [x] Clickable ads (click → redirect to destination link)
    [x] SOL + SOL98 payments
    [x] PWA install + offline service worker
    [x] Wallet-signed board writes (ed25519 verified server-side)

PHASE 2 — BLUE SCREEN OF FOMO
    [ ] Reach the 100th sale
    [ ] Launch $PIXEL98 on Pump.fun
    [ ] Airdrop to block owners (proportional)
    [ ] Pixel Hijack goes live (real token burn)

PHASE 3 — CYBER WAR
    [ ] Hijack fully on-chain
    [ ] Mobile "Win98" emulator (touch-friendly)
    [ ] On-chain indexer for live board state
    [ ] Durable board store (Supabase/Postgres)

PHASE 4 — PIXEL DAO
    [ ] Pixel Holders DAO
    [ ] Community curation + treasury votes
    [ ] Hijack mechanics tuned by governance
    [ ] The board becomes its own operating system.

================================================================================
1,000,000 pixels. 10,000 blocks. One mission.
`;

export function Roadmap() {
  return <div className="win98-notepad h-full">{ROADMAP}</div>;
}
