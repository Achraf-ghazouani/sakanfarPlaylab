-- PlayLab platform, step 5: projects belong to accounts.
-- Run once in the Supabase SQL editor after 006_sprites.sql.
-- Projects have been keyed by the login (projects.owner = auth.uid()) since 002_accounts.sql; this adds the move of
-- games made before accounts existed, and cleans up after deleted accounts.

-- ---------------------------------------------------------------- claim: the browser's old anonymous id -> this account
-- Before accounts, each browser had an id "u-" + 24 hex in localStorage (sent as the x-owner header). On the first login
-- the Studio hands that id to the server, which moves those projects to the account. Messages and versions follow their project.
create or replace function public.srv_claim_projects(p_key text, p_owner text, p_user uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform private.require_server(p_key);
  if p_owner !~ '^u-[0-9a-f]{24}$' then raise exception 'not an anonymous owner id'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'no such user'; end if;
  update public.projects set owner = p_user::text, updated_at = now() where owner = p_owner;
  get diagnostics n = row_count;
  if n > 0 then insert into public.admin_activity(admin_id, action, target, details) values (null, 'projects_claimed', p_user::text, jsonb_build_object('from', p_owner, 'count', n)); end if;
  return n;
end $$;

/** Test helper: give a project any owner (server only). */
create or replace function public.srv_set_project_owner(p_key text, p_id uuid, p_owner text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_server(p_key);
  update public.projects set owner = p_owner where id = p_id;
end $$;

-- ---------------------------------------------------------------- a deleted account takes its games with it
-- projects.owner is text (it predates accounts), so no foreign key can cascade: a trigger does it.
create or replace function private.on_profile_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.projects where owner = old.id::text;
  return old;
end $$;
drop trigger if exists profile_delete_projects on public.profiles;
create trigger profile_delete_projects after delete on public.profiles for each row execute function private.on_profile_delete();

-- leftovers from accounts deleted before this trigger existed (uuid-shaped owners with no profile), and loose rows
delete from public.projects p where p.owner ~ '^[0-9a-f-]{36}$' and not exists (select 1 from public.profiles f where f.id::text = p.owner);
delete from public.messages m where not exists (select 1 from public.projects p where p.id = m.project_id);
delete from public.versions v where not exists (select 1 from public.projects p where p.id = v.project_id);

-- ---------------------------------------------------------------- grants (server key functions: callable with the anon key + the key)
revoke execute on function public.srv_claim_projects(text, text, uuid), public.srv_set_project_owner(text, uuid, text) from public, authenticated;
grant execute on function public.srv_claim_projects(text, text, uuid), public.srv_set_project_owner(text, uuid, text) to anon;
