-- PlayLab, any game from a prompt (branch anygame, step 6): published games written as code get their own kind.
-- Run once in the Supabase SQL editor after 011_code.sql.
--   projects.kind 'code': the play page runs the game's code in the sandbox; explore can filter on it ("AI code").
-- The publish route (api/projects.js) sets it from level.genre = 'code'; until this runs it falls back to the mode's kind.

alter table public.projects drop constraint if exists projects_kind_check;
alter table public.projects add constraint projects_kind_check check (kind in ('2d', '3d', 'arena', 'code'));
