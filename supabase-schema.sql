-- LifeQuest: one save slot per user, protected by row-level security.
-- Run this once in the Supabase SQL Editor.

create table public.saves (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.saves enable row level security;

create policy "read own save"
  on public.saves for select
  using (auth.uid() = user_id);

create policy "create own save"
  on public.saves for insert
  with check (auth.uid() = user_id);

create policy "update own save"
  on public.saves for update
  using (auth.uid() = user_id);
