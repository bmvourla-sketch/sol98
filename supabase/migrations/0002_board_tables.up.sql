-- 0002_board_tables — durable backend for "Start Ads" (board.exe files +
-- their 100 sub-blocks each). Previously FILE-ONLY (data/boards.json) with
-- NO Supabase path at all — a real-money gap (2 SOL + 10% curve per file,
-- same mechanics/economics as the main board) found during the Phase 1
-- inventory (AŞAMA 1). This does not change board pricing/hijack/rent logic
-- (Red Rule #7) — it only gives that existing logic a durable place to land,
-- mirroring the pixels/pixels-data shape and the pixel_data->>owner
-- conditional-update pattern already used and documented for `pixels`.
create table if not exists public.board_files (
  id   text primary key,
  data jsonb not null
);
alter table public.board_files enable row level security;

create table if not exists public.board_pixels (
  board_id text not null,
  index    int  not null,
  data     jsonb not null,
  primary key (board_id, index)
);
alter table public.board_pixels enable row level security;

create index if not exists idx_board_pixels_owner
  on public.board_pixels ((data->>'owner'));

create index if not exists idx_board_pixels_banner_group
  on public.board_pixels ((data->>'bannerGroupId'))
  where data->>'bannerGroupId' is not null;
