-- Rollback for 0003_ownership_integrity. DESTRUCTIVE — staging/test only,
-- after a verified backup. Does not touch pixels/board_pixels/documents/
-- used_signatures (current ownership state is untouched by this rollback).
drop index if exists public.idx_payments_action;
drop index if exists public.idx_payments_wallet;
drop index if exists public.idx_ownership_pixel;
drop table if exists public.pixel_ownership_history;
drop table if exists public.payment_transactions;
