-- 0001_core_tables — the three durable stores documented in README.md
-- (pixels, documents, used_signatures). Idempotent: safe to re-run.
-- RLS is enabled with NO policies on every table — only the service_role key
-- (server-only, bypasses RLS) can read/write. No anon/publishable access.

create table if not exists public.pixels (
  index bigint primary key,
  data  jsonb not null
);
alter table public.pixels enable row level security;

-- id is TEXT, not an identity bigint: app/api/documents/route.ts generates
-- its own string id (`${Date.now()}-${random}`, see lib/document-types.ts
-- DocumentData.id: string) and sends it in the INSERT body. A `generated
-- always as identity` column (as originally documented in README.md before
-- this was staging-verified, red rule #10) REJECTS any client-supplied id —
-- found via a real dry-run insert against the staging project during Phase 1
-- testing, not by inspection. Fixed here before this schema ever reaches
-- production.
create table if not exists public.documents (
  id text primary key,
  name text not null,
  content text not null,
  owner text not null,
  "purchasedAt" bigint not null
);
alter table public.documents enable row level security;

create table if not exists public.used_signatures (
  signature text primary key,
  created_at timestamptz not null default now()
);
alter table public.used_signatures enable row level security;
