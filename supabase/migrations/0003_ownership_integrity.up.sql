-- 0003_ownership_integrity — payment idempotency + a server-written
-- ownership audit trail, covering BOTH the main board (board_id = null) and
-- every Start Ads board.exe file (board_id = that file's id). Does not
-- change any existing table or any pricing/verification logic (Red Rules
-- #5–#7) — purely additive.
create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  signature text not null unique,          -- DB-level idempotency: one row per on-chain signature
  wallet text not null,
  action text not null,                     -- buy / buy-area / hijack / buy-listing / rent / buy-board / buy-document
  amount_sol numeric,
  mint text,                                -- null for SOL
  status text not null default 'verified',
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.payment_transactions enable row level security;

create table if not exists public.pixel_ownership_history (
  id uuid primary key default gen_random_uuid(),
  pixel_index int not null,
  board_id text,                            -- null = main board, else board.exe id
  prev_owner text,
  new_owner text not null,
  action text not null,                     -- buy / buy-area / buy-listing / hijack / rent / transfer
  signature text,                           -- on-chain tx signature when applicable (free actions: null)
  created_at timestamptz not null default now()
);
alter table public.pixel_ownership_history enable row level security;

create index if not exists idx_ownership_pixel
  on public.pixel_ownership_history (pixel_index, board_id, created_at);

create index if not exists idx_payments_wallet
  on public.payment_transactions (wallet, created_at);

create index if not exists idx_payments_action
  on public.payment_transactions (action, created_at);
