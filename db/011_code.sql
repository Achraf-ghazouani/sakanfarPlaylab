-- PlayLab, any game from a prompt (branch anygame, step 2): prices for games written as code, and the Muse Wonder model row.
-- Run once in the Supabase SQL editor after 010_cap.sql.
--   code_create_2d / code_create_3d: Muse Wonder writes a whole 2D / 3D game as one HTML file (api/agent task "code").
--   code_edit: a change to such a game (the file is rewritten with the change). The plan before a build is free; so are the
--   automatic fix attempts of the self-healing loop (they run under the same charge).

insert into public.costs(action, credits, label, sort) values
  ('code_create_2d', 20, 'Custom 2D game written as code (Muse Wonder)', 12),
  ('code_create_3d', 30, 'Custom 3D game written as code (Muse Wonder)', 22),
  ('code_edit', 6, 'Change a custom game (code rewrite)', 42)
on conflict (action) do nothing;

insert into public.models(id, provider, model, label, description, multiplier, enabled, is_default, sort) values
  ('muse-wonder-1.0', 'meta', 'muse-wonder-1.0', 'Muse Wonder 1.0', 'Writes whole games as code (the strongest coding model on the Meta Model API)', 1.00, true, false, 30)
on conflict (id) do nothing;
