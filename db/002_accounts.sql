-- PlayLab platform, step 1: waitlist, approved-only accounts, roles, profiles, credit ledger, admin activity log.
--
-- Security model
--   * Every table has row-level security. Tables without policies are reachable only through the functions below.
--   * A trigger on auth.users refuses to create an account unless the email is approved on the waitlist, is an admin
--     email, or the account is created by an admin. Sign-ups are therefore closed even if Supabase's sign-up switch is on.
--   * User functions act on auth.uid() (the caller's own login). Admin functions check the caller's role in the database.
--   * Server-only functions (srv_*) require the server key (env PLAYLAB_SERVER_KEY); its SHA-256 lives in private.settings.
--     Set it once:  select private.set_server_key_hash('<sha256 hex of PLAYLAB_SERVER_KEY>');

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.settings (key text primary key, value text not null);
create table if not exists private.admin_emails (email text primary key);
create table if not exists private.rate_limits (bucket text primary key, window_start timestamptz not null, hits integer not null);

create or replace function private.set_server_key_hash(p_hash text) returns void
language sql security definer set search_path = '' as $$
  insert into private.settings(key, value) values ('server_key_sha256', lower(p_hash))
  on conflict (key) do update set value = excluded.value
$$;

create or replace function private.require_server(p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare h text;
begin
  select value into h from private.settings where key = 'server_key_sha256';
  if h is null or p_key is null or length(p_key) < 32 or encode(extensions.digest(p_key, 'sha256'), 'hex') <> h then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------- tables
create table if not exists public.waitlist (
  id bigserial primary key,
  name text not null check (char_length(name) between 1 and 80),
  email text not null unique check (email = lower(email) and char_length(email) between 5 and 254),
  message text check (char_length(message) <= 1000),
  source text check (char_length(source) <= 120),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  starting_credits integer not null default 200 check (starting_credits between 0 and 100000),
  approved_at timestamptz,
  approved_by uuid,
  invited_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists waitlist_status_idx on public.waitlist (status, created_at);
alter table public.waitlist enable row level security;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  username text unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text check (char_length(display_name) <= 60),
  avatar_url text check (char_length(avatar_url) <= 60000),
  role text not null default 'user' check (role in ('user', 'admin')),
  status text not null default 'active' check (status in ('active', 'suspended', 'banned')),
  balance integer not null default 0 check (balance >= 0),
  is_demo boolean not null default false,
  demo_tag text check (demo_tag in ('Judge', 'Tester', 'Partner')),
  demo_note text check (char_length(demo_note) <= 500),
  expires_at timestamptz,
  daily_limit integer check (daily_limit >= 0),
  created_at timestamptz not null default now(),
  last_active_at timestamptz
);
alter table public.profiles enable row level security;
create policy "own profile" on public.profiles for select to authenticated using (id = (select auth.uid()));

create table if not exists public.credit_ledger (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount integer not null,
  balance_after integer not null,
  reason text not null check (char_length(reason) <= 200),
  action text,
  model text,
  game_id uuid,
  admin_id uuid,
  refund_of bigint references public.credit_ledger(id),
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);
alter table public.credit_ledger enable row level security;
create policy "own ledger" on public.credit_ledger for select to authenticated using (user_id = (select auth.uid()));

create table if not exists public.admin_activity (
  id bigserial primary key,
  admin_id uuid,
  action text not null,
  target text,
  details jsonb,
  created_at timestamptz not null default now()
);
alter table public.admin_activity enable row level security;

-- ---------------------------------------------------------------- helpers
create or replace function private.is_admin(p_uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = p_uid and p.role = 'admin' and p.status = 'active')
$$;

create or replace function private.require_admin() returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null or not private.is_admin(uid) then raise exception 'admins only' using errcode = '42501'; end if;
  return uid;
end $$;

create or replace function private.log_admin(p_admin uuid, p_action text, p_target text, p_details jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.admin_activity(admin_id, action, target, details) values (p_admin, p_action, p_target, p_details)
$$;

/** Fixed-window rate limit. Returns true when the call is allowed. */
create or replace function private.hit(p_bucket text, p_max integer, p_window_seconds integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r private.rate_limits;
begin
  insert into private.rate_limits(bucket, window_start, hits) values (p_bucket, now(), 1)
  on conflict (bucket) do update set
    hits = case when private.rate_limits.window_start < now() - make_interval(secs => p_window_seconds) then 1 else private.rate_limits.hits + 1 end,
    window_start = case when private.rate_limits.window_start < now() - make_interval(secs => p_window_seconds) then now() else private.rate_limits.window_start end
  returning * into r;
  return r.hits <= p_max;
end $$;

/** Why a profile may not use the app right now (null = fine). */
create or replace function private.block_reason(p public.profiles) returns text
language sql stable as $$
  select case
    when p.id is null then 'no_profile'
    when p.status = 'banned' then 'banned'
    when p.status = 'suspended' then 'suspended'
    when p.is_demo and p.expires_at is not null and p.expires_at < now() then 'expired'
    else null end
$$;

-- ---------------------------------------------------------------- the approval gate on auth.users
create or replace function private.guard_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare e text := lower(new.email);
begin
  if coalesce(new.raw_app_meta_data->>'playlab_created', '') = 'admin' then return new; end if;   -- set only by admin_create_user
  if e is not null and (
       exists (select 1 from private.admin_emails a where a.email = e)
    or exists (select 1 from public.waitlist w where w.email = e and w.status = 'approved')) then
    return new;
  end if;
  raise exception 'PLAYLAB_NOT_APPROVED' using hint = 'This email has no access yet. Join the waitlist.';
end $$;
drop trigger if exists playlab_guard_new_user on auth.users;
create trigger playlab_guard_new_user before insert on auth.users for each row execute function private.guard_new_user();

create or replace function private.on_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  e text := lower(new.email);
  meta jsonb := coalesce(new.raw_app_meta_data, '{}'::jsonb);
  w public.waitlist;
  admin_email boolean := exists (select 1 from private.admin_emails a where a.email = e);
  credits integer := 0;
begin
  select * into w from public.waitlist where email = e;
  if meta ? 'playlab_credits' then credits := greatest(0, (meta->>'playlab_credits')::integer);
  elsif w.id is not null then credits := w.starting_credits;
  elsif admin_email then credits := 1000;
  end if;
  insert into public.profiles(id, email, username, display_name, role, is_demo, demo_tag, demo_note, expires_at, daily_limit, balance)
  values (new.id, e, nullif(meta->>'playlab_username', ''),
          coalesce(nullif(meta->>'playlab_display_name', ''), w.name, split_part(coalesce(e, 'player'), '@', 1)),
          case when admin_email or meta->>'playlab_role' = 'admin' then 'admin' else 'user' end,
          coalesce((meta->>'playlab_demo')::boolean, false), nullif(meta->>'playlab_tag', ''), nullif(meta->>'playlab_note', ''),
          nullif(meta->>'playlab_expires_at', '')::timestamptz, nullif(meta->>'playlab_daily_limit', '')::integer, credits)
  on conflict (id) do nothing;
  if credits > 0 then
    insert into public.credit_ledger(user_id, amount, balance_after, reason, action, admin_id)
    values (new.id, credits, credits, 'starting credits', 'grant', nullif(meta->>'playlab_admin_id', '')::uuid);
  end if;
  if w.id is not null then update public.waitlist set accepted_at = coalesce(accepted_at, now()) where id = w.id; end if;
  return new;
end $$;
drop trigger if exists playlab_on_new_user on auth.users;
create trigger playlab_on_new_user after insert on auth.users for each row execute function private.on_new_user();

-- ---------------------------------------------------------------- server-only functions (need PLAYLAB_SERVER_KEY)
create or replace function public.srv_join_waitlist(p_key text, p_name text, p_email text, p_message text, p_source text, p_ip text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e text := lower(trim(p_email)); w public.waitlist; pos bigint; already boolean := false;
begin
  perform private.require_server(p_key);
  if not private.hit('waitlist-ip:' || coalesce(p_ip, '?'), 5, 3600) then return jsonb_build_object('error', 'rate_limited'); end if;
  if not private.hit('waitlist-all', 300, 3600) then return jsonb_build_object('error', 'rate_limited'); end if;
  select * into w from public.waitlist where email = e;
  if w.id is null then
    insert into public.waitlist(name, email, message, source)
    values (left(trim(p_name), 80), e, nullif(left(trim(coalesce(p_message, '')), 1000), ''), nullif(left(trim(coalesce(p_source, '')), 120), ''))
    returning * into w;
  else already := true;
  end if;
  select count(*) into pos from public.waitlist where id <= w.id;
  return jsonb_build_object('position', pos, 'already', already, 'status', w.status);
end $$;

create or replace function public.srv_rate_limit(p_key text, p_bucket text, p_max integer, p_window_seconds integer) returns boolean
language plpgsql security definer set search_path = '' as $$
begin perform private.require_server(p_key); return private.hit(p_bucket, p_max, p_window_seconds); end $$;

/** Keep private.admin_emails equal to the ADMIN_EMAILS env and promote those accounts. */
create or replace function public.srv_sync_admins(p_key text, p_emails text[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform private.require_server(p_key);
  insert into private.admin_emails(email) select distinct lower(trim(x)) from unnest(p_emails) x where trim(x) <> '' on conflict do nothing;
  update public.profiles set role = 'admin' where email in (select email from private.admin_emails) and role <> 'admin';
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- the caller's own account
create or replace function public.me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  if p.id is null then return jsonb_build_object('blocked', 'no_profile'); end if;
  if p.last_active_at is null or p.last_active_at < now() - interval '5 minutes' then
    update public.profiles set last_active_at = now() where id = p.id;
  end if;
  return jsonb_build_object('id', p.id, 'email', p.email, 'username', p.username, 'display_name', p.display_name, 'avatar_url', p.avatar_url,
    'role', p.role, 'status', p.status, 'balance', p.balance, 'is_demo', p.is_demo, 'demo_tag', p.demo_tag, 'expires_at', p.expires_at,
    'daily_limit', p.daily_limit, 'created_at', p.created_at, 'blocked', private.block_reason(p));
end $$;

create or replace function public.update_my_profile(p_username text, p_display_name text, p_avatar_url text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  if p.id is null or private.block_reason(p) is not null then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.profiles set
    username = case when p_username is null then username else nullif(lower(trim(p_username)), '') end,
    display_name = case when p_display_name is null then display_name else nullif(left(trim(p_display_name), 60), '') end,
    avatar_url = case when p_avatar_url is null then avatar_url else nullif(p_avatar_url, '') end
  where id = p.id;
  return public.me();
end $$;

-- ---------------------------------------------------------------- admin functions (role checked in the database)
create or replace function public.admin_list_waitlist(p_status text default null, p_search text default null, p_limit integer default 200, p_offset integer default 0)
returns setof public.waitlist language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query select * from public.waitlist w
    where (p_status is null or w.status = p_status)
      and (p_search is null or w.email ilike '%' || p_search || '%' or w.name ilike '%' || p_search || '%' or w.message ilike '%' || p_search || '%')
    order by w.created_at desc limit least(p_limit, 1000) offset p_offset;
end $$;

create or replace function public.admin_set_waitlist(p_ids bigint[], p_status text, p_credits integer default 200) returns integer
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin(); n integer;
begin
  if p_status not in ('approved', 'rejected', 'pending') then raise exception 'bad status'; end if;
  update public.waitlist set status = p_status,
    starting_credits = case when p_status = 'approved' then greatest(0, least(coalesce(p_credits, 200), 100000)) else starting_credits end,
    approved_at = case when p_status = 'approved' then now() else null end,
    approved_by = case when p_status = 'approved' then a else null end
  where id = any(p_ids);
  get diagnostics n = row_count;
  -- rejecting someone who already has an account also suspends it
  if p_status = 'rejected' then
    update public.profiles set status = 'suspended' where email in (select email from public.waitlist where id = any(p_ids)) and role <> 'admin';
  end if;
  perform private.log_admin(a, 'waitlist_' || p_status, array_to_string(p_ids, ','), jsonb_build_object('credits', p_credits, 'count', n));
  return n;
end $$;

create or replace function public.admin_mark_invited(p_ids bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin(); n integer;
begin
  update public.waitlist set invited_at = now() where id = any(p_ids) and status = 'approved';
  get diagnostics n = row_count;
  perform private.log_admin(a, 'waitlist_invited', array_to_string(p_ids, ','), null);
  return n;
end $$;

/** Create a login directly (demo accounts, admin-made accounts). Username accounts get the synthetic email <username>@demo.playlab.invalid. */
create or replace function public.admin_create_user(p_email text, p_password text, p_username text default null, p_display_name text default null,
  p_credits integer default 200, p_role text default 'user', p_is_demo boolean default false, p_tag text default null, p_note text default null,
  p_expires_at timestamptz default null, p_daily_limit integer default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin(); uid uuid := gen_random_uuid(); e text := lower(trim(coalesce(nullif(p_email, ''), p_username || '@demo.playlab.invalid')));
begin
  if char_length(coalesce(p_password, '')) < 10 then raise exception 'password too short (10+)'; end if;
  if p_role not in ('user', 'admin') then raise exception 'bad role'; end if;
  if exists (select 1 from auth.users u where lower(u.email) = e) then raise exception 'email already has an account'; end if;
  insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', e, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'playlab_created', 'admin', 'playlab_admin_id', a,
      'playlab_username', lower(nullif(trim(p_username), '')), 'playlab_display_name', p_display_name, 'playlab_credits', greatest(0, coalesce(p_credits, 0)),
      'playlab_role', p_role, 'playlab_demo', coalesce(p_is_demo, false), 'playlab_tag', p_tag, 'playlab_note', p_note,
      'playlab_expires_at', p_expires_at, 'playlab_daily_limit', p_daily_limit),
    '{}'::jsonb, now(), now(), '', '', '', '', '', '', '', '');
  insert into auth.identities(id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid::text, uid, jsonb_build_object('sub', uid::text, 'email', e, 'email_verified', true), 'email', null, now(), now());
  perform private.log_admin(a, case when p_is_demo then 'demo_create' else 'user_create' end, uid::text, jsonb_build_object('email', e, 'credits', p_credits, 'tag', p_tag));
  return uid;
end $$;

create or replace function public.admin_set_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin();
begin
  if char_length(coalesce(p_password, '')) < 10 then raise exception 'password too short (10+)'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now() where id = p_user;
  perform private.log_admin(a, 'password_reset', p_user::text, null);
end $$;

create or replace function public.admin_set_user(p_user uuid, p_status text default null, p_role text default null, p_expires_at timestamptz default null,
  p_clear_expiry boolean default false, p_daily_limit integer default null, p_clear_daily_limit boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin(); p public.profiles;
begin
  if p_user = a and (p_status is not null and p_status <> 'active' or p_role = 'user') then raise exception 'you cannot lock yourself out'; end if;
  update public.profiles set
    status = coalesce(p_status, status), role = coalesce(p_role, role),
    expires_at = case when p_clear_expiry then null else coalesce(p_expires_at, expires_at) end,
    daily_limit = case when p_clear_daily_limit then null else coalesce(p_daily_limit, daily_limit) end
  where id = p_user returning * into p;
  if p.id is null then raise exception 'no such user'; end if;
  -- suspended / banned accounts cannot get new sessions either
  update auth.users set banned_until = case when p.status = 'active' then null else 'infinity'::timestamptz end where id = p_user;
  perform private.log_admin(a, 'user_update', p_user::text, jsonb_build_object('status', p_status, 'role', p_role, 'expires_at', p_expires_at, 'daily_limit', p_daily_limit));
  return to_jsonb(p);
end $$;

create or replace function public.admin_delete_user(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin(); e text;
begin
  if p_user = a then raise exception 'you cannot delete yourself'; end if;
  select email into e from auth.users where id = p_user;
  delete from auth.users where id = p_user;   -- cascades to profiles, ledger
  perform private.log_admin(a, 'user_delete', p_user::text, jsonb_build_object('email', e));
end $$;

create or replace function public.admin_list_users(p_search text default null, p_demo boolean default null, p_limit integer default 200, p_offset integer default 0)
returns setof public.profiles language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query select * from public.profiles p
    where (p_search is null or p.email ilike '%' || p_search || '%' or p.username ilike '%' || p_search || '%' or p.display_name ilike '%' || p_search || '%')
      and (p_demo is null or p.is_demo = p_demo)
    order by p.created_at desc limit least(p_limit, 1000) offset p_offset;
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.srv_join_waitlist(text, text, text, text, text, text), public.srv_rate_limit(text, text, integer, integer),
  public.srv_sync_admins(text, text[]) from public, authenticated;
grant execute on function public.srv_join_waitlist(text, text, text, text, text, text), public.srv_rate_limit(text, text, integer, integer),
  public.srv_sync_admins(text, text[]) to anon;
revoke execute on function public.me(), public.update_my_profile(text, text, text),
  public.admin_list_waitlist(text, text, integer, integer), public.admin_set_waitlist(bigint[], text, integer), public.admin_mark_invited(bigint[]),
  public.admin_create_user(text, text, text, text, integer, text, boolean, text, text, timestamptz, integer), public.admin_set_password(uuid, text),
  public.admin_set_user(uuid, text, text, timestamptz, boolean, integer, boolean), public.admin_delete_user(uuid),
  public.admin_list_users(text, boolean, integer, integer) from public, anon;
grant execute on function public.me(), public.update_my_profile(text, text, text),
  public.admin_list_waitlist(text, text, integer, integer), public.admin_set_waitlist(bigint[], text, integer), public.admin_mark_invited(bigint[]),
  public.admin_create_user(text, text, text, text, integer, text, boolean, text, text, timestamptz, integer), public.admin_set_password(uuid, text),
  public.admin_set_user(uuid, text, text, timestamptz, boolean, integer, boolean), public.admin_delete_user(uuid),
  public.admin_list_users(text, boolean, integer, integer) to authenticated;

-- ---------------------------------------------------------------- projects belong to logins now (was: anonymous x-owner header)
alter policy "owner projects" on public.projects to authenticated
  using (owner = (select auth.uid())::text) with check (owner = (select auth.uid())::text);
alter policy "owner messages" on public.messages to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner = (select auth.uid())::text))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner = (select auth.uid())::text));
alter policy "owner versions" on public.versions to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner = (select auth.uid())::text))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner = (select auth.uid())::text));
alter policy "shared projects are public" on public.projects to anon, authenticated;
alter policy "shared versions are public" on public.versions to anon, authenticated;

-- ---------------------------------------------------------------- server key + first admin
-- SHA-256 of PLAYLAB_SERVER_KEY from your .env (the key itself stays on the server).
select private.set_server_key_hash('a5529b64a0804cc74ddbd61eb8450810a9aef9fa1d6e9eea03a5e7b91e31b673');
insert into private.admin_emails(email) values ('contact@sakanfarproductions.com') on conflict do nothing;
