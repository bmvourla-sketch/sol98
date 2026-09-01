-- 0004b_fix_atomic_rpc_search_path — closes the Supabase linter's WARN
-- "function_search_path_mutable" for both Phase 3 RPC functions (raised by
-- mcp__Supabase__get_advisors right after 0004 was applied to staging).
-- Every table reference in both function bodies is already schema-qualified
-- (public.pixels, public.board_pixels, public.purchase_intents,
-- public.payment_transactions, public.pixel_ownership_history), so this is
-- defense-in-depth against search_path manipulation rather than a fix for
-- an active bug — pinning search_path to empty means there is no
-- unqualified identifier left for a malicious search_path to redirect.
-- Mirrors the existing 0001b_fix_documents_id_type hotfix-migration pattern.
alter function public.update_pixel_owner_atomic(
  bigint, text, jsonb, text, text, text, numeric, text, uuid, text, text, boolean
) set search_path = '';

alter function public.update_board_pixel_owner_atomic(
  text, int, text, jsonb, text, text, text, numeric, text, uuid, text, text, boolean
) set search_path = '';
