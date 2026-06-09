-- Shared default presets — everyone reads them; "Save preset" inserts into here.
-- Run once in your Supabase project's SQL Editor. Safe to re-run.
--
-- NOTE: for now anyone (even signed-out visitors) can add/remove shared presets.
-- That's fine while you're authoring defaults. To lock it down later, replace the
-- insert/delete policies with `to authenticated` or an admin check.

create table if not exists public.shared_presets (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  data       jsonb not null,            -- { camera: {...}, devices: [...] }
  created_at timestamptz not null default now()
);

alter table public.shared_presets enable row level security;

-- Everyone can read the shared defaults.
drop policy if exists "shared_presets_read" on public.shared_presets;
create policy "shared_presets_read" on public.shared_presets
  for select using (true);

-- For now, anyone may add a shared preset.
drop policy if exists "shared_presets_insert" on public.shared_presets;
create policy "shared_presets_insert" on public.shared_presets
  for insert with check (true);

-- For now, anyone may remove a shared preset.
drop policy if exists "shared_presets_delete" on public.shared_presets;
create policy "shared_presets_delete" on public.shared_presets
  for delete using (true);
