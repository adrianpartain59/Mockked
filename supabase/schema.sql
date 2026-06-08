-- iPhone Mockup Generator — Supabase schema
-- Run this once in your project's SQL Editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: every statement is idempotent.

-- ---------------------------------------------------------------------------
-- Table: one row per saved mockup, owned by the signed-in user.
-- ---------------------------------------------------------------------------
create table if not exists public.mockups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null default 'Untitled',
  settings    jsonb not null default '{}'::jsonb,   -- color, rotation, fit, brightness…
  image_path  text,                                 -- file in the `mockups` storage bucket
  created_at  timestamptz not null default now()
);

alter table public.mockups enable row level security;

-- Each user can only see and touch their own rows.
drop policy if exists "mockups_select_own" on public.mockups;
create policy "mockups_select_own" on public.mockups
  for select using (auth.uid() = user_id);

drop policy if exists "mockups_insert_own" on public.mockups;
create policy "mockups_insert_own" on public.mockups
  for insert with check (auth.uid() = user_id);

drop policy if exists "mockups_update_own" on public.mockups;
create policy "mockups_update_own" on public.mockups
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "mockups_delete_own" on public.mockups;
create policy "mockups_delete_own" on public.mockups
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Storage: private bucket for the uploaded screen images.
-- Files are stored under a per-user folder: "<user_id>/<random>.png".
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('mockups', 'mockups', false)
on conflict (id) do nothing;

-- A user may only read/write files inside their own "<user_id>/" folder.
drop policy if exists "mockup_files_select_own" on storage.objects;
create policy "mockup_files_select_own" on storage.objects
  for select using (
    bucket_id = 'mockups' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "mockup_files_insert_own" on storage.objects;
create policy "mockup_files_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'mockups' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "mockup_files_update_own" on storage.objects;
create policy "mockup_files_update_own" on storage.objects
  for update using (
    bucket_id = 'mockups' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "mockup_files_delete_own" on storage.objects;
create policy "mockup_files_delete_own" on storage.objects
  for delete using (
    bucket_id = 'mockups' and (storage.foldername(name))[1] = auth.uid()::text
  );
