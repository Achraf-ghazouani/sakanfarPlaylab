-- PlayLab platform, step 7: SAM 3.1 cutouts (api/art.js task "cutout", lib/segment.mjs).
-- Run once in the Supabase SQL editor after 008_publish.sql.
--   cutout on sam-3.1: SAM 3.1 finds the character or object in a picture and returns its pixel mask; the page cuts it out. 1 credit.

insert into public.costs(action, credits, label, sort) values ('cutout', 1, 'Cut a picture out (SAM 3.1)', 46)
on conflict (action) do update set credits = 1, label = excluded.label, sort = excluded.sort where public.costs.credits = 3;   -- 004 left a 3-credit placeholder

insert into public.models(id, provider, model, label, description, multiplier, enabled, is_default, sort) values
  ('sam-3.1', 'meta', 'sam-3.1', 'SAM 3.1', 'Cutouts: finds the thing in a picture (segmentation model)', 1.00, true, false, 55)
on conflict (id) do nothing;
