-- Shared default presets — everyone reads them; "Save preset" inserts into here.
-- Run once in your Supabase project's SQL Editor. Safe to re-run.
--
-- NOTE: for now anyone (even signed-out visitors) can add/remove shared presets.
-- That's fine while you're authoring defaults. To lock it down later, replace the
-- insert/delete policies with `to authenticated` or an admin check.

create table if not exists public.shared_presets (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  data       jsonb not null,            -- { devices: [...] }
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

-- ---------------------------------------------------------------------------
-- Seed the built-in defaults so the DB is the single source of truth.
-- These used to be hardcoded in presets.js (DEFAULT_PRESETS). Idempotent:
-- each insert only runs if a preset with that name doesn't already exist.
-- ---------------------------------------------------------------------------

insert into public.shared_presets (name, data)
select 'Front', '{
  "devices": [{ "pos": [0, 0, 0], "rot": [0, 0, 0], "scale": [1, 1, 1] }]
}'::jsonb
where not exists (select 1 from public.shared_presets where name = 'Front');

insert into public.shared_presets (name, data)
select 'TwoPhone1', '{
  "devices": [
    { "type": "iphone17pro", "pos": [0.03, -0.02, -0.08], "rot": [-0.1571, 0.2793, -0.1745], "scale": [1, 1, 1] },
    { "type": "iphone17pro", "pos": [-0.03, 0, 0], "rot": [-0.2269, 0.5061, 0.1222], "scale": [1, 1, 1] }
  ]
}'::jsonb
where not exists (select 1 from public.shared_presets where name = 'TwoPhone1');

-- Drop any stored camera view from existing rows so all presets are
-- camera-consistent (the app no longer reads or writes camera either way).
update public.shared_presets set data = data - 'camera' where data ? 'camera';
