-- PlayLab Studio: projects (a chat + its game), messages, versions.
-- Access goes through the app's serverless functions, which send the owner token in an x-owner header.
-- RLS keys every row on that header, so the public anon key alone cannot read anyone's data.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner text not null,
  title text not null default 'Untitled game',
  mode text not null default '2d' check (mode in ('2d','3d-side','3d-world')),
  level jsonb,
  photo text,
  art jsonb,
  rules jsonb,
  share_id text unique,
  play_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_owner_updated_idx on public.projects (owner, updated_at desc);

create table if not exists public.messages (
  id bigserial primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  role text not null check (role in ('user','assistant','system','tool')),
  content text not null default '',
  meta jsonb,
  created_at timestamptz not null default now()
);
create index if not exists messages_project_idx on public.messages (project_id, id);

create table if not exists public.versions (
  id bigserial primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  n integer not null,
  level jsonb not null,
  note text,
  created_at timestamptz not null default now(),
  unique (project_id, n)
);

alter table public.projects enable row level security;
alter table public.messages enable row level security;
alter table public.versions enable row level security;

create or replace function public.req_owner() returns text
language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json->>'x-owner', '')
$$;

create policy "owner projects" on public.projects for all to anon
  using (public.req_owner() <> '' and owner = public.req_owner())
  with check (public.req_owner() <> '' and owner = public.req_owner());

create policy "shared projects are public" on public.projects for select to anon
  using (share_id is not null);

create policy "owner messages" on public.messages for all to anon
  using (exists (select 1 from public.projects p where p.id = project_id and public.req_owner() <> '' and p.owner = public.req_owner()))
  with check (exists (select 1 from public.projects p where p.id = project_id and public.req_owner() <> '' and p.owner = public.req_owner()));

create policy "owner versions" on public.versions for all to anon
  using (exists (select 1 from public.projects p where p.id = project_id and public.req_owner() <> '' and p.owner = public.req_owner()))
  with check (exists (select 1 from public.projects p where p.id = project_id and public.req_owner() <> '' and p.owner = public.req_owner()));

create policy "shared versions are public" on public.versions for select to anon
  using (exists (select 1 from public.projects p where p.id = project_id and p.share_id is not null));

-- Public play counter: anyone may bump it for a shared project (no other column is writable this way).
create or replace function public.bump_play_count(p_share_id text) returns integer
language sql security definer set search_path = public as $$
  update public.projects set play_count = play_count + 1 where share_id = p_share_id returning play_count
$$;
grant execute on function public.bump_play_count(text) to anon;
