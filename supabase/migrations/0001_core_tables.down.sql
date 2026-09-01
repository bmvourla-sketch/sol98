-- Rollback for 0001_core_tables. Drops the three core tables.
-- DESTRUCTIVE — only ever run against staging/test, never production, and
-- only after a verified backup (see docs/production-readiness/PHASE-1-DATABASE.md §10).
drop table if exists public.used_signatures;
drop table if exists public.documents;
drop table if exists public.pixels;
