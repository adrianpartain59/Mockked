// Presets are now stored entirely in Supabase (the `shared_presets` table) so
// there is a single source of truth. The previous built-in defaults ("Front",
// "TwoPhone1") have been migrated into that table — see supabase/presets.sql.
//
// This array is intentionally empty. To add a shared default, use "Save preset"
// in the app (which inserts a row into shared_presets) or seed it via SQL.
export const DEFAULT_PRESETS = [];
