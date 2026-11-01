-- PlayLab platform: server-only account functions (need PLAYLAB_SERVER_KEY).
-- Used by the automated tests to create and remove throwaway accounts, and by the server for bootstrap tasks.
-- They reuse admin_create_user's logic without an admin session, so they are locked behind the server key.

create or replace function public.srv_create_user(p_key text, p_email text, p_password text, p_username text default null,
  p_display_name text default null, p_credits integer default 200, p_role text default 'user', p_is_demo boolean default false,
  p_tag text default null, p_expires_at timestamptz default null, p_daily_limit integer default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := gen_random_uuid(); e text := lower(trim(coalesce(nullif(p_email, ''), p_username || '@demo.playlab.invalid')));
begin
  perform private.require_server(p_key);
  if char_length(coalesce(p_password, '')) < 10 then raise exception 'password too short (10+)'; end if;
  if p_role not in ('user', 'admin') then raise exception 'bad role'; end if;
  if exists (select 1 from auth.users u where lower(u.email) = e) then raise exception 'email already has an account'; end if;
  insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', e, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'playlab_created', 'admin',
      'playlab_username', lower(nullif(trim(p_username), '')), 'playlab_display_name', p_display_name, 'playlab_credits', greatest(0, coalesce(p_credits, 0)),
      'playlab_role', p_role, 'playlab_demo', coalesce(p_is_demo, false), 'playlab_tag', p_tag,
      'playlab_expires_at', p_expires_at, 'playlab_daily_limit', p_daily_limit),
    '{}'::jsonb, now(), now(), '', '', '', '', '', '', '', '');
  insert into auth.identities(id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid::text, uid, jsonb_build_object('sub', uid::text, 'email', e, 'email_verified', true), 'email', null, now(), now());
  insert into public.admin_activity(admin_id, action, target, details) values (null, 'server_user_create', uid::text, jsonb_build_object('email', e, 'role', p_role));
  return uid;
end $$;

create or replace function public.srv_delete_user(p_key text, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_server(p_key);
  delete from auth.users where id = p_user;
  insert into public.admin_activity(admin_id, action, target, details) values (null, 'server_user_delete', p_user::text, null);
end $$;

/** Waitlist status change by the server (tests; the admin panel uses admin_set_waitlist). */
create or replace function public.srv_set_waitlist(p_key text, p_email text, p_status text, p_credits integer default 200) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform private.require_server(p_key);
  if p_status = 'deleted' then delete from public.waitlist where email = lower(trim(p_email)); get diagnostics n = row_count; return n; end if;
  if p_status not in ('approved', 'rejected', 'pending') then raise exception 'bad status'; end if;
  update public.waitlist set status = p_status, starting_credits = greatest(0, coalesce(p_credits, 200)),
    approved_at = case when p_status = 'approved' then now() else null end where email = lower(trim(p_email));
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.srv_create_user(text, text, text, text, text, integer, text, boolean, text, timestamptz, integer),
  public.srv_delete_user(text, uuid), public.srv_set_waitlist(text, text, text, integer) from public, authenticated;
grant execute on function public.srv_create_user(text, text, text, text, text, integer, text, boolean, text, timestamptz, integer),
  public.srv_delete_user(text, uuid), public.srv_set_waitlist(text, text, text, integer) to anon;
