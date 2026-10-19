-- Selah database setup for Supabase
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Before running, change the email on the line marked  <<< YOUR EMAIL  to the email
-- you will sign in to Selah with. That account becomes the admin who can see testers.

-- 1. Who is the admin --------------------------------------------------------
create table if not exists public.admins (
  email text primary key
);
insert into public.admins (email) values ('your-email@example.com')   -- <<< YOUR EMAIL
on conflict do nothing;
alter table public.admins enable row level security;  -- nobody can read this list through the app

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.is_admin() to authenticated;

-- 2. Each person's private documents (profile, progress, journal, chat, marks) --
create table if not exists public.user_docs (
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (name ~ '^[a-z]{1,20}$'),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, name),
  constraint user_docs_size check (pg_column_size(data) < 900000)
);
alter table public.user_docs enable row level security;
drop policy if exists "own docs: read" on public.user_docs;
drop policy if exists "own docs: insert" on public.user_docs;
drop policy if exists "own docs: update" on public.user_docs;
drop policy if exists "own docs: delete" on public.user_docs;
create policy "own docs: read"   on public.user_docs for select to authenticated using (user_id = auth.uid());
create policy "own docs: insert" on public.user_docs for insert to authenticated with check (user_id = auth.uid());
create policy "own docs: update" on public.user_docs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own docs: delete" on public.user_docs for delete to authenticated using (user_id = auth.uid());

-- 3. Tester summaries (first name, topics, progress), visible only to the admin --
create table if not exists public.testers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint testers_size check (pg_column_size(data) < 20000)
);
alter table public.testers enable row level security;
drop policy if exists "testers: admin reads all" on public.testers;
drop policy if exists "testers: own insert" on public.testers;
drop policy if exists "testers: own update" on public.testers;
create policy "testers: admin reads all" on public.testers for select to authenticated using (public.is_admin() or user_id = auth.uid());
create policy "testers: own insert" on public.testers for insert to authenticated with check (user_id = auth.uid());
create policy "testers: own update" on public.testers for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 4. Family circle: people who share the same code see each other -------------
create table if not exists public.circle (
  user_id uuid primary key references auth.users (id) on delete cascade,
  code text check (code is null or code ~ '^[A-Z0-9-]{3,24}$'),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint circle_size check (pg_column_size(data) < 4000)
);
create index if not exists circle_code_idx on public.circle (code);
alter table public.circle enable row level security;

create or replace function public.my_circle_code()
returns text
language sql stable security definer set search_path = public
as $$ select code from public.circle where user_id = auth.uid() $$;
grant execute on function public.my_circle_code() to authenticated;

drop policy if exists "circle: same code or self" on public.circle;
drop policy if exists "circle: own insert" on public.circle;
drop policy if exists "circle: own update" on public.circle;
create policy "circle: same code or self" on public.circle for select to authenticated
  using (user_id = auth.uid() or (code is not null and code = public.my_circle_code()));
create policy "circle: own insert" on public.circle for insert to authenticated with check (user_id = auth.uid());
create policy "circle: own update" on public.circle for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 5. Encouragement notes between people in the same circle --------------------
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  to_user uuid not null references auth.users (id) on delete cascade,
  from_user uuid not null references auth.users (id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now(),
  constraint notes_size check (pg_column_size(data) < 4000)
);
create index if not exists notes_to_idx on public.notes (to_user, created_at desc);
alter table public.notes enable row level security;
drop policy if exists "notes: read mine" on public.notes;
drop policy if exists "notes: send within circle" on public.notes;
create policy "notes: read mine" on public.notes for select to authenticated
  using (to_user = auth.uid() or from_user = auth.uid());
create policy "notes: send within circle" on public.notes for insert to authenticated
  with check (
    from_user = auth.uid()
    and public.my_circle_code() is not null
    and exists (select 1 from public.circle c where c.user_id = to_user and c.code = public.my_circle_code())
  );

-- 6. Daily AI limit (used only by the server, never by the app directly) -------
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
-- no policies: only the server (service role) can touch this table

create or replace function public.bump_ai_usage(p_user uuid, p_limit int)
returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  insert into public.ai_usage (user_id, day, count)
  values (p_user, (now() at time zone 'Africa/Lagos')::date, 1)
  on conflict (user_id, day) do update set count = public.ai_usage.count + 1
  returning count into n;
  if n > p_limit then
    update public.ai_usage set count = count - 1
      where user_id = p_user and day = (now() at time zone 'Africa/Lagos')::date;
    return -1;
  end if;
  return n;
end;
$$;
revoke all on function public.bump_ai_usage(uuid, int) from public, anon, authenticated;
grant execute on function public.bump_ai_usage(uuid, int) to service_role;

-- Done. You should see "Success. No rows returned".
