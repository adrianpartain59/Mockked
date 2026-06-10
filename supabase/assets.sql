-- Uploaded assets library — one row per image/video a user uploads, shown in the
-- "Uploaded assets" tab of the import dialog and reused across mockups.
-- Run once in your Supabase project's SQL Editor. Safe to re-run.

create table if not exists public.user_assets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null default 'asset',
  mime       text not null default '',
  kind       text not null default 'image',   -- 'image' | 'video'
  path       text not null,                    -- file in the `assets` storage bucket
  created_at timestamptz not null default now()
);

alter table public.user_assets enable row level security;

drop policy if exists "user_assets_select_own" on public.user_assets;
create policy "user_assets_select_own" on public.user_assets
  for select using (auth.uid() = user_id);

drop policy if exists "user_assets_insert_own" on public.user_assets;
create policy "user_assets_insert_own" on public.user_assets
  for insert with check (auth.uid() = user_id);

drop policy if exists "user_assets_delete_own" on public.user_assets;
create policy "user_assets_delete_own" on public.user_assets
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Storage: private bucket for uploaded assets, one folder per user.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('assets', 'assets', false)
on conflict (id) do nothing;

drop policy if exists "asset_files_select_own" on storage.objects;
create policy "asset_files_select_own" on storage.objects
  for select using (
    bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "asset_files_insert_own" on storage.objects;
create policy "asset_files_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "asset_files_delete_own" on storage.objects;
create policy "asset_files_delete_own" on storage.objects
  for delete using (
    bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text
  );
