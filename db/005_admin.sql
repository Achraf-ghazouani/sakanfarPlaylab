-- PlayLab platform, step 3: what the admin panel (admin.html) needs on top of 002 and 004.
-- Run once in the Supabase SQL editor after 004_credits.sql. Every function checks the caller's admin role in the database.

-- ---------------------------------------------------------------- overview: one call for the dashboard numbers
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a uuid := private.require_admin(); result jsonb;
begin
  with spend as (   -- credits used = charges minus their refunds (admin grants are not usage)
    select l.*, -l.amount as used from public.credit_ledger l where l.action is distinct from 'admin' and (l.amount < 0 or l.refund_of is not null)
  )
  select jsonb_build_object(
    'users', (select jsonb_build_object(
        'total', count(*), 'active', count(*) filter (where status = 'active'), 'suspended', count(*) filter (where status = 'suspended'),
        'banned', count(*) filter (where status = 'banned'), 'demo', count(*) filter (where is_demo), 'admins', count(*) filter (where role = 'admin'),
        'active_7d', count(*) filter (where last_active_at > now() - interval '7 days'), 'balance', coalesce(sum(balance), 0)) from public.profiles),
    'waitlist', (select jsonb_build_object('pending', count(*) filter (where status = 'pending'), 'approved', count(*) filter (where status = 'approved'),
        'rejected', count(*) filter (where status = 'rejected'), 'total', count(*)) from public.waitlist),
    'spent', (select jsonb_build_object(
        'today', coalesce(sum(used) filter (where created_at >= date_trunc('day', now())), 0),
        'd7', coalesce(sum(used) filter (where created_at > now() - interval '7 days'), 0),
        'd30', coalesce(sum(used) filter (where created_at > now() - interval '30 days'), 0),
        'calls_today', count(*) filter (where amount < 0 and created_at >= date_trunc('day', now())),
        'refunds_30d', count(*) filter (where refund_of is not null and created_at > now() - interval '30 days')) from spend),
    'granted_30d', (select coalesce(sum(amount), 0) from public.credit_ledger where action = 'admin' and created_at > now() - interval '30 days'),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'credits', d.credits, 'calls', d.calls) order by d.day), '[]'::jsonb) from (
        select g.day::date as day, coalesce(sum(s.used), 0) as credits, count(s.id) filter (where s.amount < 0) as calls
        from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') g(day)
        left join spend s on date_trunc('day', s.created_at) = g.day group by g.day) d),
    'by_action', (select coalesce(jsonb_agg(jsonb_build_object('action', x.action, 'credits', x.credits, 'calls', x.calls) order by x.credits desc), '[]'::jsonb) from (
        select coalesce(action, '?') as action, sum(used) as credits, count(*) filter (where amount < 0) as calls from spend
        where created_at > now() - interval '30 days' group by 1) x),
    'by_model', (select coalesce(jsonb_agg(jsonb_build_object('model', x.model, 'credits', x.credits, 'calls', x.calls) order by x.credits desc), '[]'::jsonb) from (
        select coalesce(model, '?') as model, sum(used) as credits, count(*) filter (where amount < 0) as calls from spend
        where created_at > now() - interval '30 days' group by 1) x),
    'top_users', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'email', x.email, 'username', x.username, 'credits', x.credits, 'calls', x.calls) order by x.credits desc), '[]'::jsonb) from (
        select p.id, p.email, p.username, sum(s.used) as credits, count(*) filter (where s.amount < 0) as calls
        from spend s join public.profiles p on p.id = s.user_id where s.created_at > now() - interval '30 days'
        group by p.id order by 4 desc limit 10) x)
  ) into result;
  return result;
end $$;

-- ---------------------------------------------------------------- usage: everyone's ledger (the users' own policy only shows their rows)
create or replace function public.admin_list_ledger(p_user uuid default null, p_action text default null, p_limit integer default 200, p_offset integer default 0)
returns table (id bigint, user_id uuid, email text, username text, amount integer, balance_after integer, reason text, action text, model text,
  game_id uuid, admin_email text, refund_of bigint, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query select l.id, l.user_id, p.email, p.username, l.amount, l.balance_after, l.reason, l.action, l.model, l.game_id, ad.email, l.refund_of, l.created_at
    from public.credit_ledger l join public.profiles p on p.id = l.user_id left join public.profiles ad on ad.id = l.admin_id
    where (p_user is null or l.user_id = p_user) and (p_action is null or l.action = p_action)
    order by l.id desc limit least(p_limit, 1000) offset p_offset;
end $$;

-- ---------------------------------------------------------------- prices and models
create or replace function public.admin_set_cost(p_action text, p_credits integer, p_label text default null) returns public.costs
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin(); c public.costs;
begin
  if p_credits is null or p_credits < 0 or p_credits > 100000 then raise exception 'credits must be 0 to 100000'; end if;
  update public.costs set credits = p_credits, label = coalesce(nullif(trim(p_label), ''), label), updated_at = now(), updated_by = a
    where action = p_action returning * into c;
  if c.action is null then raise exception 'no such action'; end if;
  perform private.log_admin(a, 'cost_update', p_action, jsonb_build_object('credits', p_credits, 'label', p_label));
  return c;
end $$;

/** All models, also the switched-off ones (the public policy only shows enabled models). */
create or replace function public.admin_list_models() returns setof public.models
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query select * from public.models order by sort, id;
end $$;

create or replace function public.admin_set_model(p_id text, p_multiplier numeric default null, p_enabled boolean default null, p_is_default boolean default null,
  p_label text default null, p_description text default null) returns public.models
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin(); m public.models;
begin
  select * into m from public.models where id = p_id for update;
  if m.id is null then raise exception 'no such model'; end if;
  if p_multiplier is not null and (p_multiplier <= 0 or p_multiplier > 20) then raise exception 'multiplier must be above 0 and at most 20'; end if;
  if (p_enabled = false or (p_enabled is null and not m.enabled)) and (p_is_default = true or (p_is_default is null and m.is_default)) then
    raise exception 'the default model must stay switched on';
  end if;
  if p_is_default = false and m.is_default then raise exception 'pick another model as the default instead'; end if;
  if p_is_default = true then update public.models set is_default = false where is_default and id <> p_id; end if;
  update public.models set multiplier = coalesce(p_multiplier, multiplier), enabled = coalesce(p_enabled, enabled), is_default = coalesce(p_is_default, is_default),
    label = coalesce(nullif(trim(p_label), ''), label), description = coalesce(p_description, description), updated_at = now()
    where id = p_id returning * into m;
  perform private.log_admin(a, 'model_update', p_id, jsonb_build_object('multiplier', p_multiplier, 'enabled', p_enabled, 'is_default', p_is_default));
  return m;
end $$;

-- ---------------------------------------------------------------- admin activity log
create or replace function public.admin_list_activity(p_limit integer default 100, p_offset integer default 0)
returns table (id bigint, admin_email text, action text, target text, details jsonb, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query select x.id, p.email, x.action, x.target, x.details, x.created_at
    from public.admin_activity x left join public.profiles p on p.id = x.admin_id
    order by x.id desc limit least(p_limit, 500) offset p_offset;
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on function public.admin_overview(), public.admin_list_ledger(uuid, text, integer, integer), public.admin_set_cost(text, integer, text),
  public.admin_list_models(), public.admin_set_model(text, numeric, boolean, boolean, text, text), public.admin_list_activity(integer, integer) from public, anon;
grant execute on function public.admin_overview(), public.admin_list_ledger(uuid, text, integer, integer), public.admin_set_cost(text, integer, text),
  public.admin_list_models(), public.admin_set_model(text, numeric, boolean, boolean, text, text), public.admin_list_activity(integer, integer) to authenticated;
