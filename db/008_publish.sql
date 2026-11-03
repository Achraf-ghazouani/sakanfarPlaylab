-- PlayLab platform, step 6: publish, share, remix.
-- Run once in the Supabase SQL editor after 007_claim.sql.
--   A project becomes a public or unlisted game at /play/<share_id>: anyone can play it, count a play, like it, report it,
--   and (logged in) remix it into their own games. explore_games() feeds the gallery; admins feature, unpublish, delete.

-- ---------------------------------------------------------------- columns
alter table public.projects
  add column if not exists description text check (char_length(description) <= 300),
  add column if not exists cover text check (char_length(cover) <= 250000),      -- small JPEG data URL for cards
  add column if not exists og_image text check (char_length(og_image) <= 400000), -- 1200x630 card for link previews
  add column if not exists visibility text not null default 'private' check (visibility in ('private', 'public', 'unlisted')),
  add column if not exists kind text check (kind in ('2d', '3d', 'arena')),
  add column if not exists published_at timestamptz,
  add column if not exists featured_at timestamptz,
  add column if not exists like_count integer not null default 0;
create index if not exists projects_public_idx on public.projects (visibility, published_at desc);

create table if not exists public.likes (
  share_id text not null,
  voter text not null check (char_length(voter) between 16 and 64),   -- the login id, or a random browser token
  created_at timestamptz not null default now(),
  primary key (share_id, voter)
);
alter table public.likes enable row level security;

create table if not exists public.reports (
  id bigserial primary key,
  share_id text not null,
  reason text not null check (reason in ('inappropriate', 'broken', 'spam', 'copyright', 'other')),
  details text check (char_length(details) <= 500),
  reporter text,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_by uuid,
  closed_at timestamptz
);
create index if not exists reports_status_idx on public.reports (status, created_at desc);
alter table public.reports enable row level security;

-- ---------------------------------------------------------------- who may read a published game
drop policy if exists "shared projects are public" on public.projects;
create policy "shared projects are public" on public.projects for select to anon, authenticated
  using (share_id is not null and visibility in ('public', 'unlisted'));
drop policy if exists "shared versions are public" on public.versions;
create policy "shared versions are public" on public.versions for select to anon, authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.share_id is not null and p.visibility in ('public', 'unlisted')));

-- counters and the featured flag are only ever changed by the functions below (an owner can PATCH their own row through RLS)
create or replace function private.guard_project_counters() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('playlab.system', true) is distinct from '1' and (auth.uid() is null or not private.is_admin(auth.uid())) then
    if new.like_count <> old.like_count or new.play_count <> old.play_count or new.featured_at is distinct from old.featured_at then
      raise exception 'counters and featuring are set by the game, not by its owner' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_project_counters on public.projects;
create trigger guard_project_counters before update on public.projects for each row execute function private.guard_project_counters();

create or replace function private.author_of(p_owner text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(p.display_name, ''), p.username, 'a PlayLab maker') from public.profiles p where p.id::text = p_owner
$$;
create or replace function private.kind_of(p_mode text) returns text
language sql immutable as $$ select case when p_mode = '3d-world' then 'arena' when p_mode = '3d-side' then '3d' else '2d' end $$;

-- ---------------------------------------------------------------- public reads
/** One published game, for /play/<id>: what the page needs, never the owner. */
create or replace function public.public_game(p_share_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', share_id, 'title', title, 'description', description, 'kind', coalesce(kind, private.kind_of(mode)), 'mode', mode,
    'level', level, 'art', art, 'photo', photo, 'cover', cover, 'author', private.author_of(owner), 'plays', play_count, 'likes', like_count,
    'published_at', published_at, 'featured', featured_at is not null, 'visibility', visibility)
  from public.projects where share_id = p_share_id and visibility in ('public', 'unlisted') and level is not null
$$;
/** The link preview: the card picture and the words, nothing else (cheap, cacheable). */
create or replace function public.public_game_card(p_share_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', share_id, 'title', title, 'description', description, 'kind', coalesce(kind, private.kind_of(mode)),
    'author', private.author_of(owner), 'og_image', og_image, 'cover', cover)
  from public.projects where share_id = p_share_id and visibility in ('public', 'unlisted') and level is not null
$$;
/** The gallery: public games only. p_sort trending | newest | featured, p_kind 2d | 3d | arena, p_q words in the title/description/author. */
create or replace function public.explore_games(p_sort text default 'trending', p_kind text default null, p_q text default null, p_limit integer default 60, p_offset integer default 0) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) from (
    select share_id as id, title, description, coalesce(kind, private.kind_of(mode)) as kind, cover, private.author_of(owner) as author,
      play_count as plays, like_count as likes, published_at, (featured_at is not null) as featured
    from public.projects p
    where visibility = 'public' and level is not null and share_id is not null
      and (p_kind is null or coalesce(kind, private.kind_of(mode)) = p_kind)
      and (p_q is null or p_q = '' or title ilike '%' || p_q || '%' or coalesce(description, '') ilike '%' || p_q || '%' or private.author_of(owner) ilike '%' || p_q || '%')
    order by
      case when p_sort = 'featured' then (featured_at is not null)::int else 0 end desc,
      case when p_sort = 'newest' then published_at end desc,
      case when p_sort = 'featured' then featured_at end desc,
      case when p_sort not in ('newest') then (play_count + 3 * like_count + 1)::numeric / power(extract(epoch from (now() - coalesce(published_at, now()))) / 3600 + 2, 1.1) end desc,
      published_at desc
    limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)
  ) g
$$;

-- ---------------------------------------------------------------- public writes: plays, likes, reports (rate limited per caller)
drop function if exists public.bump_play_count(text);   -- the old share counter: played_game below replaces it (the trigger would block it)
create or replace function public.played_game(p_share_id text) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform set_config('playlab.system', '1', true);
  update public.projects set play_count = play_count + 1 where share_id = p_share_id and visibility in ('public', 'unlisted') returning play_count into n;
  return n;
end $$;
create or replace function public.toggle_like(p_share_id text, p_voter text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare liked boolean; n integer;
begin
  if char_length(coalesce(p_voter, '')) < 16 then raise exception 'bad voter'; end if;
  if not exists (select 1 from public.projects where share_id = p_share_id and visibility in ('public', 'unlisted')) then raise exception 'no such game'; end if;
  if not private.hit('like:' || left(p_voter, 64), 60, 3600) then raise exception 'too many likes, try later'; end if;
  perform set_config('playlab.system', '1', true);
  if exists (select 1 from public.likes where share_id = p_share_id and voter = p_voter) then
    delete from public.likes where share_id = p_share_id and voter = p_voter; liked := false;
  else
    insert into public.likes(share_id, voter) values (p_share_id, p_voter); liked := true;
  end if;
  update public.projects set like_count = (select count(*) from public.likes l where l.share_id = p_share_id) where share_id = p_share_id returning like_count into n;
  return jsonb_build_object('liked', liked, 'likes', n);
end $$;
create or replace function public.liked_by(p_share_id text, p_voter text) returns boolean
language sql stable security definer set search_path = '' as $$ select exists (select 1 from public.likes where share_id = p_share_id and voter = p_voter) $$;
create or replace function public.report_game(p_share_id text, p_reason text, p_details text, p_reporter text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare rid bigint;
begin
  if not exists (select 1 from public.projects where share_id = p_share_id and visibility in ('public', 'unlisted')) then raise exception 'no such game'; end if;
  if not private.hit('report:' || left(coalesce(p_reporter, 'anon'), 64), 5, 3600) then raise exception 'too many reports, try later'; end if;
  insert into public.reports(share_id, reason, details, reporter) values (p_share_id, p_reason, left(p_details, 500), left(p_reporter, 64)) returning id into rid;
  return rid;
end $$;

-- ---------------------------------------------------------------- remix: a copy in the caller's games (the API charges the edit first)
create or replace function public.remix_game(p_share_id text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); src public.projects; nid uuid;
begin
  if uid is null then raise exception 'login required' using errcode = '42501'; end if;
  select * into src from public.projects where share_id = p_share_id and visibility in ('public', 'unlisted') and level is not null;
  if src.id is null then raise exception 'no such game'; end if;
  insert into public.projects(owner, title, mode, level, photo, art, rules, kind)
    values (uid::text, left('Remix of ' || src.title, 80), src.mode, src.level, src.photo, src.art, src.rules, coalesce(src.kind, private.kind_of(src.mode))) returning id into nid;
  insert into public.versions(project_id, n, level, note) values (nid, 1, src.level, 'remixed from ' || src.share_id);
  insert into public.messages(project_id, role, content, meta) values (nid, 'tool', 'Remixed from "' || src.title || '" by ' || private.author_of(src.owner), jsonb_build_object('card', jsonb_build_object('icon', '&#127922;', 'title', 'Remix', 'text', 'from "' || src.title || '" by ' || private.author_of(src.owner))));
  return nid;
end $$;

-- ---------------------------------------------------------------- admin
create or replace function public.admin_list_games(p_filter text default 'published', p_limit integer default 200, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform private.require_admin();
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) into result from (
    select p.id, p.share_id, p.title, p.description, coalesce(p.kind, private.kind_of(p.mode)) as kind, p.visibility, p.cover, p.owner, private.author_of(p.owner) as author,
      (select f.email from public.profiles f where f.id::text = p.owner) as email, p.play_count as plays, p.like_count as likes, p.published_at, p.featured_at,
      (select count(*) from public.reports r where r.share_id = p.share_id and r.status = 'open') as open_reports, p.updated_at
    from public.projects p
    where (p_filter = 'all') or (p_filter = 'published' and p.visibility <> 'private') or (p_filter = 'featured' and p.featured_at is not null)
       or (p_filter = 'reported' and exists (select 1 from public.reports r where r.share_id = p.share_id and r.status = 'open'))
    order by p.published_at desc nulls last, p.updated_at desc limit least(p_limit, 500) offset p_offset) g;
  return result;
end $$;
create or replace function public.admin_set_game(p_id uuid, p_visibility text default null, p_featured boolean default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin(); p public.projects;
begin
  if p_visibility is not null and p_visibility not in ('private', 'public', 'unlisted') then raise exception 'bad visibility'; end if;
  perform set_config('playlab.system', '1', true);
  update public.projects set visibility = coalesce(p_visibility, visibility),
    featured_at = case when p_featured is null then featured_at when p_featured then coalesce(featured_at, now()) else null end
    where id = p_id returning * into p;
  if p.id is null then raise exception 'no such game'; end if;
  perform private.log_admin(a, 'game_update', p_id::text, jsonb_build_object('visibility', p_visibility, 'featured', p_featured, 'title', p.title));
  return jsonb_build_object('id', p.id, 'visibility', p.visibility, 'featured', p.featured_at is not null);
end $$;
create or replace function public.admin_delete_game(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin(); t text;
begin
  select title into t from public.projects where id = p_id;
  delete from public.projects where id = p_id;
  perform private.log_admin(a, 'game_delete', p_id::text, jsonb_build_object('title', t));
end $$;
create or replace function public.admin_list_reports(p_status text default 'open', p_limit integer default 200) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform private.require_admin();
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) into result from (
    select r.id, r.share_id, r.reason, r.details, r.reporter, r.status, r.created_at, p.title, p.visibility, p.id as project_id
    from public.reports r left join public.projects p on p.share_id = r.share_id
    where p_status is null or r.status = p_status order by r.created_at desc limit least(p_limit, 500)) g;
  return result;
end $$;
create or replace function public.admin_close_report(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin();
begin
  update public.reports set status = 'closed', closed_by = a, closed_at = now() where id = p_id;
  perform private.log_admin(a, 'report_close', p_id::text, null);
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.public_game(text), public.public_game_card(text), public.explore_games(text, text, text, integer, integer), public.played_game(text),
  public.toggle_like(text, text), public.liked_by(text, text), public.report_game(text, text, text, text) from public;
grant execute on function public.public_game(text), public.public_game_card(text), public.explore_games(text, text, text, integer, integer), public.played_game(text),
  public.toggle_like(text, text), public.liked_by(text, text), public.report_game(text, text, text, text) to anon, authenticated;
revoke execute on function public.remix_game(text), public.admin_list_games(text, integer, integer), public.admin_set_game(uuid, text, boolean), public.admin_delete_game(uuid),
  public.admin_list_reports(text, integer), public.admin_close_report(bigint) from public, anon;
grant execute on function public.remix_game(text), public.admin_list_games(text, integer, integer), public.admin_set_game(uuid, text, boolean), public.admin_delete_game(uuid),
  public.admin_list_reports(text, integer), public.admin_close_report(bigint) to authenticated;
