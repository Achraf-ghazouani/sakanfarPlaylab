-- PlayLab platform, step 8: a global daily spending cap (admin setting).
-- Run once in the Supabase SQL editor after 009_cutout.sql.
--   The admin sets how many credits everyone together may use per day (UTC). When it is reached, charges for regular users
--   are refused with error 'global_cap' (nothing is deducted; the Studio shows a friendly message); admins are never blocked.
--   The setting lives in private.settings ('global_daily_cap', 0 = no cap); credits used = charges minus refunds, admin
--   grants not counted, everyone's usage counted (admins too: it is the real bill).

create or replace function private.global_cap() returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce((select nullif(trim(value), '')::integer from private.settings where key = 'global_daily_cap'), 0)
$$;
create or replace function private.global_spent_today() returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(-sum(amount), 0)::integer from public.credit_ledger
  where created_at >= date_trunc('day', now()) and (amount < 0 or refund_of is not null) and action is distinct from 'admin'
$$;

-- ---------------------------------------------------------------- the charge, now with the global cap (otherwise as in 004)
create or replace function public.charge(p_action text, p_model text default null, p_game_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles; c public.costs; m public.models; cost integer; spent integer; lid bigint; reason text; cap integer; spent_all integer;
begin
  select * into p from public.profiles where id = auth.uid() for update;
  if p.id is null then return jsonb_build_object('ok', false, 'error', 'blocked', 'blocked', 'no_profile'); end if;
  reason := private.block_reason(p);
  if reason is not null then return jsonb_build_object('ok', false, 'error', 'blocked', 'blocked', reason); end if;
  select * into c from public.costs where action = p_action;
  if c.action is null then return jsonb_build_object('ok', false, 'error', 'unknown_action'); end if;
  if p_model is null then select * into m from public.models where is_default and enabled limit 1;
  else select * into m from public.models where id = p_model; end if;
  if m.id is null or not m.enabled then return jsonb_build_object('ok', false, 'error', 'model_disabled', 'model', p_model); end if;
  cost := ceil(c.credits * m.multiplier)::integer;
  if cost > p.balance then
    return jsonb_build_object('ok', false, 'error', 'insufficient_credits', 'cost', cost, 'balance', p.balance, 'action', p_action);
  end if;
  if p.daily_limit is not null and cost > 0 then
    -- credits used today (UTC): charges minus their refunds
    select coalesce(-sum(amount), 0) into spent from public.credit_ledger
      where user_id = p.id and created_at >= date_trunc('day', now()) and (amount < 0 or refund_of is not null) and action <> 'admin';
    if spent + cost > p.daily_limit then
      return jsonb_build_object('ok', false, 'error', 'daily_limit', 'cost', cost, 'spent_today', spent, 'daily_limit', p.daily_limit);
    end if;
  end if;
  -- everyone's budget for today: regular users stop at the cap, admins never do
  cap := private.global_cap();
  if cap > 0 and cost > 0 and p.role <> 'admin' then
    spent_all := private.global_spent_today();
    if spent_all + cost > cap then
      return jsonb_build_object('ok', false, 'error', 'global_cap', 'cost', cost, 'balance', p.balance, 'cap', cap, 'spent_today_all', spent_all,
        'resets_at', date_trunc('day', now()) + interval '1 day');
    end if;
  end if;
  update public.profiles set balance = balance - cost, last_active_at = now() where id = p.id;
  insert into public.credit_ledger(user_id, amount, balance_after, reason, action, model, game_id)
    values (p.id, -cost, p.balance - cost, c.label, p_action, m.id, p_game_id) returning id into lid;
  return jsonb_build_object('ok', true, 'ledger_id', lid, 'cost', cost, 'balance', p.balance - cost, 'model', m.id, 'provider', m.provider, 'model_name', m.model);
end $$;

-- ---------------------------------------------------------------- what the pages may know
/** For any login: is the shared budget used up (so the Studio can say so before a charge)? Admins see reached=false. */
create or replace function public.cap_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cap integer := private.global_cap(); spent_all integer := private.global_spent_today(); admin boolean := private.is_admin(auth.uid());
begin
  return jsonb_build_object('cap', cap, 'spent_today', spent_all, 'reached', cap > 0 and spent_all >= cap and not admin,
    'resets_at', date_trunc('day', now()) + interval '1 day');
end $$;

-- ---------------------------------------------------------------- admin
create or replace function public.admin_get_settings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return jsonb_build_object('global_daily_cap', private.global_cap(), 'spent_today_all', private.global_spent_today(),
    'resets_at', date_trunc('day', now()) + interval '1 day');
end $$;
create or replace function public.admin_set_setting(p_key text, p_value text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin(); n integer;
begin
  if p_key = 'global_daily_cap' then
    n := coalesce(nullif(trim(p_value), ''), '0')::integer;
    if n < 0 or n > 100000000 then raise exception 'the cap must be 0 (no cap) to 100000000 credits'; end if;
    insert into private.settings(key, value) values (p_key, n::text) on conflict (key) do update set value = excluded.value;
  else
    raise exception 'no such setting';
  end if;
  perform private.log_admin(a, 'setting_update', p_key, jsonb_build_object('value', p_value));
  return public.admin_get_settings();
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.cap_status(), public.admin_get_settings(), public.admin_set_setting(text, text) from public, anon;
grant execute on function public.cap_status(), public.admin_get_settings(), public.admin_set_setting(text, text) to authenticated;
