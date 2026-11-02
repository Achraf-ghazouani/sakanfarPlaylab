-- PlayLab platform, step 4: pictures in the Studio (api/art.js).
-- Run once in the Supabase SQL editor after 004_credits.sql.
--   classify: Muse Spark looks at an uploaded picture (level, character or object), 1 credit.
--   art on muse-image-1.0: Muse Image redraws it as a game sprite, the existing "art" price (15) x 1.

insert into public.costs(action, credits, label, sort) values ('classify', 1, 'Look at a picture', 45)
on conflict (action) do nothing;

insert into public.models(id, provider, model, label, description, multiplier, enabled, is_default, sort) values
  ('muse-image-1.0', 'meta', 'muse-image-1.0', 'Muse Image 1.0', 'Sprites and art (image model)', 1.00, true, false, 50)
on conflict (id) do nothing;
