-- PlayLab platform, step 2: costs, models with multipliers, atomic charge + refund.
-- Run once in the Supabase SQL editor after 002_accounts.sql and 003_server_users.sql.

-- small hardening from the security advisor
alter function public.req_owner() set search_path = '';
alter function private.block_reason(public.profiles) set search_path = '';

-- ---------------------------------------------------------------- prices (admin-editable, readable by everyone)
create table if not exists public.costs (
  action text primary key check (action ~ '^[a-z0-9_]{2,40}$'),
  credits integer not null check (credits between 0 and 100000),
  label text not null,
  sort integer not null default 100,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.costs enable row level security;
create policy "costs are public" on public.costs for select to anon, authenticated using (true);

insert into public.costs(action, credits, label, sort) values
  ('create_2d', 10, 'Create a 2D game', 10),
  ('create_3d', 25, 'Create a 3D game', 20),
  ('edit_2d', 2, 'Edit a 2D game', 30),
  ('edit_3d', 5, 'Edit a 3D game', 40),
  ('scan', 8, 'Sketch or camera scan', 50),
  ('art', 15, 'Generate art (Muse Image)', 60),
  ('ui_kit', 10, 'Generate a UI kit', 70),
  ('cutout', 3, 'Cutout sprite (SAM 3.1)', 80),
  ('playtest', 3, 'Playtest and fix', 90),
  ('publish', 0, 'Publish', 100)
on conflict (action) do nothing;

-- ---------------------------------------------------------------- models (admin-editable, enabled ones readable by everyone)
create table if not exists public.models (
  id text primary key check (id ~ '^[a-z0-9._-]{2,60}$'),
  provider text not null check (provider in ('meta', 'baseten')),
  model text not null,
  label text not null,
  description text not null default '',
  multiplier numeric(6,2) not null default 1 check (multiplier > 0 and multiplier <= 20),
  enabled boolean not null default true,
  is_default boolean not null default false,
  sort integer not null default 100,
  updated_at timestamptz not null default now()
);
create unique index if not exists models_one_default on public.models (is_default) where is_default;
alter table public.models enable row level security;
create policy "enabled models are public" on public.models for select to anon, authenticated using (enabled);

insert into public.models(id, provider, model, label, description, multiplier, enabled, is_default, sort) values
  ('muse-spark-1.3', 'meta', 'muse-spark-1.3', 'Muse Spark 1.3', 'Best quality', 1.00, true, true, 10),
  ('muse-spark-1.2', 'meta', 'muse-spark-1.2', 'Muse Spark 1.2', 'Fast and reliable', 0.80, true, false, 20),
  ('muse-spark-1.1', 'meta', 'muse-spark-1.1', 'Muse Spark 1.1', 'Fastest', 0.60, true, false, 30),
  ('muse-spark-open', 'baseten', 'meta-models/muse-spark-open-1026', 'Muse Spark Open', 'Cheapest (open weights on Baseten)', 0.50, true, false, 40)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- the charge (atomic: check, limit, deduct, ledger)
/**
 * Called by the server with the user's own token, before an AI call.
 * Returns { ok, ledger_id, cost, balance } or { ok:false, error: 'insufficient_credits' | 'daily_limit' | 'blocked' | 'unknown_action' | 'model_disabled', ... }.
 * The row lock on the profile makes two parallel charges queue instead of both passing the balance check.
 */
create or replace function public.charge(p_action text, p_model text default null, p_game_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles; c public.costs; m public.models; cost integer; spent integer; lid bigint; reason text;
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
  update public.profiles set balance = balance - cost, last_active_at = now() where id = p.id;
  insert into public.credit_ledger(user_id, amount, balance_after, reason, action, model, game_id)
    values (p.id, -cost, p.balance - cost, c.label, p_action, m.id, p_game_id) returning id into lid;
  return jsonb_build_object('ok', true, 'ledger_id', lid, 'cost', cost, 'balance', p.balance - cost, 'model', m.id, 'provider', m.provider, 'model_name', m.model);
end $$;

/** Give a charge back (the AI call failed). Server only, once per charge. */
create or replace function public.srv_refund(p_key text, p_ledger_id bigint, p_reason text default 'refund: the AI call failed') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.credit_ledger; bal integer;
begin
  perform private.require_server(p_key);
  select * into l from public.credit_ledger where id = p_ledger_id for update;
  if l.id is null or l.amount >= 0 then return jsonb_build_object('ok', false, 'error', 'not_a_charge'); end if;
  if exists (select 1 from public.credit_ledger r where r.refund_of = l.id) then return jsonb_build_object('ok', false, 'error', 'already_refunded'); end if;
  update public.profiles set balance = balance - l.amount where id = l.user_id returning balance into bal;
  insert into public.credit_ledger(user_id, amount, balance_after, reason, action, model, game_id, refund_of)
    values (l.user_id, -l.amount, bal, left(p_reason, 200), l.action, l.model, l.game_id, l.id);
  return jsonb_build_object('ok', true, 'balance', bal);
end $$;

/** Admin: add (or remove, negative) credits with a reason, written to the ledger. */
create or replace function public.admin_grant_credits(p_users uuid[], p_amount integer, p_reason text) returns integer
language plpgsql security definer set search_path = '' as $$
declare a uuid := private.require_admin(); n integer := 0; u uuid; bal integer;
begin
  if p_amount = 0 or abs(p_amount) > 1000000 then raise exception 'bad amount'; end if;
  if char_length(coalesce(trim(p_reason), '')) < 2 then raise exception 'a reason is required'; end if;
  foreach u in array p_users loop
    update public.profiles set balance = greatest(0, balance + p_amount) where id = u returning balance into bal;
    if found then
      insert into public.credit_ledger(user_id, amount, balance_after, reason, action, admin_id) values (u, p_amount, bal, left(trim(p_reason), 200), 'admin', a);
      n := n + 1;
    end if;
  end loop;
  perform private.log_admin(a, 'credits', array_to_string(p_users, ','), jsonb_build_object('amount', p_amount, 'reason', p_reason, 'count', n));
  return n;
end $$;

/** Test helper: change a balance directly (server only). */
create or replace function public.srv_set_profile(p_key text, p_user uuid, p_balance integer default null, p_daily_limit integer default null, p_clear_daily_limit boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_server(p_key);
  update public.profiles set balance = coalesce(p_balance, balance),
    daily_limit = case when p_clear_daily_limit then null else coalesce(p_daily_limit, daily_limit) end where id = p_user;
end $$;

revoke execute on function public.charge(text, text, uuid), public.admin_grant_credits(uuid[], integer, text) from public, anon;
grant execute on function public.charge(text, text, uuid), public.admin_grant_credits(uuid[], integer, text) to authenticated;
revoke execute on function public.srv_refund(text, bigint, text), public.srv_set_profile(text, uuid, integer, integer, boolean) from public, authenticated;
grant execute on function public.srv_refund(text, bigint, text), public.srv_set_profile(text, uuid, integer, integer, boolean) to anon;
