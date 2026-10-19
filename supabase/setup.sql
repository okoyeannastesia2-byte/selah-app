-- =====================================================================
--  SELAH · database setup for Supabase
--  How to use: Supabase dashboard → SQL Editor → New query →
--  paste this whole file → change the two emails in STEP 2 → Run.
--  Safe to run again: it only creates what is missing.
-- =====================================================================

-- ---------------------------------------------------------------------
-- STEP 1 · Tables
-- ---------------------------------------------------------------------

-- Each person's private Selah data (profile, progress, journal, chat, marks).
create table if not exists public.selah_docs (
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  name       text        not null check (char_length(name) between 1 and 40),
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);

-- Owner(s): can see the Testers page.
create table if not exists public.selah_admins (
  email text primary key
);

-- Members: people you invited. Only members can use the AI helper
-- and see the family circle. Everyone else can still read the Bible,
-- plans and meditations, with progress saved to their account.
create table if not exists public.selah_members (
  email    text primary key,
  added_at timestamptz not null default now()
);

-- Summary each person shares with the owner (first name, topics, progress).
create table if not exists public.selah_testers (
  user_id    uuid        primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Family circle: first name + last active day, visible to members.
create table if not exists public.selah_circle (
  user_id    uuid        primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Encouragement notes between members.
create table if not exists public.selah_notes (
  id         bigint      generated always as identity primary key,
  to_user    uuid        not null references auth.users(id) on delete cascade,
  from_user  uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists selah_notes_to_idx on public.selah_notes (to_user, created_at desc);

-- AI helper usage per person per day (for the daily limit).
create table if not exists public.selah_ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);

-- ---------------------------------------------------------------------
-- STEP 2 · YOUR EMAILS  (change these, then Run)
-- ---------------------------------------------------------------------
insert into public.selah_admins  (email) values (lower('your-email@example.com')) on conflict do nothing;
insert into public.selah_members (email) values (lower('your-email@example.com')) on conflict do nothing;
-- Add family and friends the same way, one line each:
-- insert into public.selah_members (email) values (lower('sister@example.com')) on conflict do nothing;

-- ---------------------------------------------------------------------
-- STEP 3 · Helper functions
-- ---------------------------------------------------------------------
create or replace function public.selah_email() returns text
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.selah_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.selah_admins a where lower(a.email) = public.selah_email())
$$;

create or replace function public.selah_is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select public.selah_is_admin()
      or exists (select 1 from public.selah_members m where lower(m.email) = public.selah_email())
$$;

-- What the app asks once after sign-in.
create or replace function public.selah_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', auth.uid(),
    'email', public.selah_email(),
    'is_admin', public.selah_is_admin(),
    'is_member', public.selah_is_member()
  )
$$;

-- Called by the n8n workflow before every AI request.
-- Counts the request and says whether it is allowed today.
create or replace function public.selah_ai_hit(daily_limit int default 40) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  d    date := (now() at time zone 'Africa/Lagos')::date;
  used int;
begin
  if uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'signed_out');
  end if;
  if not public.selah_is_member() then
    return jsonb_build_object('allowed', false, 'reason', 'not_member');
  end if;
  insert into public.selah_ai_usage as u (user_id, day, count) values (uid, d, 1)
  on conflict (user_id, day) do update set count = u.count + 1
  returning u.count into used;
  return jsonb_build_object('allowed', used <= greatest(daily_limit, 1), 'used', used, 'limit', daily_limit,
                            'reason', case when used <= greatest(daily_limit, 1) then 'ok' else 'daily_limit' end);
end
$$;

-- ---------------------------------------------------------------------
-- STEP 4 · Security rules (row level security)
-- ---------------------------------------------------------------------
alter table public.selah_docs     enable row level security;
alter table public.selah_admins   enable row level security;
alter table public.selah_members  enable row level security;
alter table public.selah_testers  enable row level security;
alter table public.selah_circle   enable row level security;
alter table public.selah_notes    enable row level security;
alter table public.selah_ai_usage enable row level security;

-- selah_docs: only you, only your rows.
drop policy if exists "docs: own read"   on public.selah_docs;
drop policy if exists "docs: own insert" on public.selah_docs;
drop policy if exists "docs: own update" on public.selah_docs;
drop policy if exists "docs: own delete" on public.selah_docs;
create policy "docs: own read"   on public.selah_docs for select to authenticated using (user_id = auth.uid());
create policy "docs: own insert" on public.selah_docs for insert to authenticated with check (user_id = auth.uid());
create policy "docs: own update" on public.selah_docs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "docs: own delete" on public.selah_docs for delete to authenticated using (user_id = auth.uid());

-- selah_testers: everyone writes their own summary; only the owner reads all.
drop policy if exists "testers: own read"   on public.selah_testers;
drop policy if exists "testers: admin read" on public.selah_testers;
drop policy if exists "testers: own insert" on public.selah_testers;
drop policy if exists "testers: own update" on public.selah_testers;
create policy "testers: own read"   on public.selah_testers for select to authenticated using (user_id = auth.uid());
create policy "testers: admin read" on public.selah_testers for select to authenticated using (public.selah_is_admin());
create policy "testers: own insert" on public.selah_testers for insert to authenticated with check (user_id = auth.uid());
create policy "testers: own update" on public.selah_testers for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- selah_circle: members see each other and write their own row.
drop policy if exists "circle: own read"    on public.selah_circle;
drop policy if exists "circle: member read" on public.selah_circle;
drop policy if exists "circle: own insert"  on public.selah_circle;
drop policy if exists "circle: own update"  on public.selah_circle;
create policy "circle: own read"    on public.selah_circle for select to authenticated using (user_id = auth.uid());
create policy "circle: member read" on public.selah_circle for select to authenticated using (public.selah_is_member());
create policy "circle: own insert"  on public.selah_circle for insert to authenticated with check (user_id = auth.uid() and public.selah_is_member());
create policy "circle: own update"  on public.selah_circle for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and public.selah_is_member());

-- selah_notes: members send notes; you read notes sent to you or by you.
drop policy if exists "notes: read mine" on public.selah_notes;
drop policy if exists "notes: send"      on public.selah_notes;
create policy "notes: read mine" on public.selah_notes for select to authenticated using (to_user = auth.uid() or from_user = auth.uid());
create policy "notes: send"      on public.selah_notes for insert to authenticated with check (from_user = auth.uid() and public.selah_is_member());

-- selah_admins, selah_members, selah_ai_usage: no direct access from the app
-- (only through the functions above). You manage them in the Table Editor.

-- ---------------------------------------------------------------------
-- STEP 5 · Permissions
-- ---------------------------------------------------------------------
revoke all on public.selah_docs, public.selah_testers, public.selah_circle, public.selah_notes,
              public.selah_admins, public.selah_members, public.selah_ai_usage from anon;
grant select, insert, update, delete on public.selah_docs    to authenticated;
grant select, insert, update         on public.selah_testers to authenticated;
grant select, insert, update         on public.selah_circle  to authenticated;
grant select, insert                 on public.selah_notes   to authenticated;

revoke execute on function public.selah_me(), public.selah_ai_hit(int), public.selah_is_admin(), public.selah_is_member() from public, anon;
grant  execute on function public.selah_me(), public.selah_ai_hit(int), public.selah_is_admin(), public.selah_is_member() to authenticated;

-- Done. You should see "Success. No rows returned".
