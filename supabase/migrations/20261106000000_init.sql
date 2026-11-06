-- Hale Build Tracker: schema, access rules, file storage
-- Each build is a "project". People see a project only if they are a member.
-- All tracker data (phases, costs, selections, log...) lives in `records`, one row per item.

-- ---------- tables ----------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'House build' check (char_length(name) between 1 and 120),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner','editor')),
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user_idx on public.project_members(user_id);

create table public.invites (
  project_id uuid not null references public.projects(id) on delete cascade,
  email text not null check (email = lower(email) and email like '%_@_%'),
  role text not null default 'editor' check (role in ('owner','editor')),
  invited_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (project_id, email)
);
create index invites_email_idx on public.invites(email);

create table public.records (
  project_id uuid not null references public.projects(id) on delete cascade,
  collection text not null check (collection ~ '^[a-z]{2,24}$'),
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,100}$'),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 262144),
  updated_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, collection, id)
);
alter table public.records replica identity full;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
create trigger records_touch before update on public.records
  for each row execute function public.touch_updated_at();

-- ---------- membership helpers ----------
create or replace function public.is_member(p uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.project_members m where m.project_id = p and m.user_id = (select auth.uid()));
$$;

create or replace function public.is_owner(p uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.project_members m where m.project_id = p and m.user_id = (select auth.uid()) and m.role = 'owner');
$$;

-- storage paths are "<project_id>/<file>"
create or replace function public.is_member_path(object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.project_members m
    where m.project_id::text = split_part(object_name, '/', 1) and m.user_id = (select auth.uid()));
$$;

-- ---------- actions ----------
-- Create a build; the creator becomes its owner.
create or replace function public.create_project(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); pid uuid; u record;
begin
  if uid is null then raise exception 'Sign in first'; end if;
  select email, coalesce(raw_user_meta_data->>'display_name','') as dn into u from auth.users where id = uid;
  insert into public.projects(name, created_by) values (coalesce(nullif(trim(p_name),''),'House build'), uid) returning id into pid;
  insert into public.project_members(project_id, user_id, role, email, display_name) values (pid, uid, 'owner', u.email, nullif(u.dn,''));
  return pid;
end $$;

-- Join every project this (confirmed) email was invited to.
create or replace function public.accept_invites() returns integer
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); u record; n integer := 0;
begin
  if uid is null then return 0; end if;
  select email, email_confirmed_at, coalesce(raw_user_meta_data->>'display_name','') as dn into u from auth.users where id = uid;
  if u.email is null or u.email_confirmed_at is null then return 0; end if;
  insert into public.project_members(project_id, user_id, role, email, display_name)
    select i.project_id, uid, i.role, lower(u.email), nullif(u.dn,'') from public.invites i where i.email = lower(u.email)
    on conflict (project_id, user_id) do nothing;
  get diagnostics n = row_count;
  delete from public.invites where email = lower(u.email);
  return n;
end $$;

revoke all on function public.create_project(text), public.accept_invites(), public.is_member(uuid), public.is_owner(uuid), public.is_member_path(text) from public, anon;
grant execute on function public.create_project(text), public.accept_invites(), public.is_member(uuid), public.is_owner(uuid), public.is_member_path(text) to authenticated;

-- ---------- row level security ----------
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.invites enable row level security;
alter table public.records enable row level security;

create policy "members read project" on public.projects for select to authenticated using (public.is_member(id));
create policy "owners rename project" on public.projects for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));
create policy "owners delete project" on public.projects for delete to authenticated using (public.is_owner(id));

create policy "members see members" on public.project_members for select to authenticated using (public.is_member(project_id));
create policy "owners change roles" on public.project_members for update to authenticated using (public.is_owner(project_id)) with check (public.is_owner(project_id));
create policy "owners remove members, anyone can leave" on public.project_members for delete to authenticated
  using (public.is_owner(project_id) or user_id = (select auth.uid()));

create policy "members see invites" on public.invites for select to authenticated using (public.is_member(project_id));
create policy "owners invite" on public.invites for insert to authenticated with check (public.is_owner(project_id));
create policy "owners cancel invites" on public.invites for delete to authenticated using (public.is_owner(project_id));

create policy "members read records" on public.records for select to authenticated using (public.is_member(project_id));
create policy "members add records" on public.records for insert to authenticated with check (public.is_member(project_id));
create policy "members edit records" on public.records for update to authenticated using (public.is_member(project_id)) with check (public.is_member(project_id));
create policy "members delete records" on public.records for delete to authenticated using (public.is_member(project_id));

revoke all on public.projects, public.project_members, public.invites, public.records from anon;

-- ---------- realtime ----------
alter publication supabase_realtime add table public.records;

-- ---------- file storage (photos, PDFs) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('files', 'files', false, 20971520, array['image/jpeg','image/png','image/webp','image/gif','application/pdf'])
on conflict (id) do nothing;

create policy "members read files" on storage.objects for select to authenticated
  using (bucket_id = 'files' and public.is_member_path(name));
create policy "members upload files" on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and public.is_member_path(name));
create policy "members delete files" on storage.objects for delete to authenticated
  using (bucket_id = 'files' and public.is_member_path(name));
