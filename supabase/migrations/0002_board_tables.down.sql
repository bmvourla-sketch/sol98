-- Rollback for 0002_board_tables. DESTRUCTIVE — staging/test only, after a
-- verified backup.
drop index if exists public.idx_board_pixels_banner_group;
drop index if exists public.idx_board_pixels_owner;
drop table if exists public.board_pixels;
drop table if exists public.board_files;
