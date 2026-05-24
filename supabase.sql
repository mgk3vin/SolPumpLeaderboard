create table if not exists public.leaderboard_entries (
  rank integer primary key,
  name text not null,
  wagered numeric not null default 0,
  baseline_wager numeric not null default 0,
  current_wager numeric not null default 0,
  deposits numeric not null default 0,
  bets numeric not null default 0,
  profit numeric not null default 0,
  commission_generated numeric not null default 0,
  first_seen timestamptz,
  last_seen timestamptz,
  blocked boolean not null default false,
  avatar text,
  updated_at timestamptz not null default now()
);

alter table public.leaderboard_entries
add column if not exists commission_generated numeric not null default 0;

alter table public.leaderboard_entries
add column if not exists baseline_wager numeric not null default 0;

alter table public.leaderboard_entries
add column if not exists current_wager numeric not null default 0;

alter table public.leaderboard_entries
add column if not exists first_seen timestamptz;

alter table public.leaderboard_entries
add column if not exists last_seen timestamptz;

alter table public.leaderboard_entries
add column if not exists blocked boolean not null default false;

create table if not exists public.admin_users (
  email text primary key
);

create table if not exists public.leaderboard_settings (
  id integer primary key default 1,
  pot numeric not null default 0,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null default (now() + interval '7 days'),
  updated_at timestamptz not null default now(),
  constraint leaderboard_settings_singleton check (id = 1)
);

alter table public.leaderboard_entries enable row level security;
alter table public.admin_users enable row level security;
alter table public.leaderboard_settings enable row level security;

drop policy if exists "Admins can read own row" on public.admin_users;
create policy "Admins can read own row"
on public.admin_users
for select
to authenticated
using (email = lower(auth.jwt() ->> 'email'));

drop policy if exists "Public leaderboard read" on public.leaderboard_entries;
create policy "Public leaderboard read"
on public.leaderboard_entries
for select
to anon, authenticated
using (true);

drop policy if exists "Public settings read" on public.leaderboard_settings;
create policy "Public settings read"
on public.leaderboard_settings
for select
to anon, authenticated
using (true);

drop policy if exists "Admin leaderboard insert" on public.leaderboard_entries;
create policy "Admin leaderboard insert"
on public.leaderboard_entries
for insert
to authenticated
with check (
  exists (
    select 1
    from public.admin_users
    where admin_users.email = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Admin leaderboard delete" on public.leaderboard_entries;
create policy "Admin leaderboard delete"
on public.leaderboard_entries
for delete
to authenticated
using (
  exists (
    select 1
    from public.admin_users
    where admin_users.email = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Admin settings insert" on public.leaderboard_settings;
create policy "Admin settings insert"
on public.leaderboard_settings
for insert
to authenticated
with check (
  exists (
    select 1
    from public.admin_users
    where admin_users.email = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Admin settings update" on public.leaderboard_settings;
create policy "Admin settings update"
on public.leaderboard_settings
for update
to authenticated
using (
  exists (
    select 1
    from public.admin_users
    where admin_users.email = lower(auth.jwt() ->> 'email')
  )
)
with check (
  exists (
    select 1
    from public.admin_users
    where admin_users.email = lower(auth.jwt() ->> 'email')
  )
);

insert into public.leaderboard_settings (id)
values (1)
on conflict (id) do nothing;

-- Then add your admin email:
-- insert into public.admin_users (email)
-- values ('your-admin-email@example.com')
-- on conflict (email) do nothing;
