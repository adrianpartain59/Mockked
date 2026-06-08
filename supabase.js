import { createClient } from "@supabase/supabase-js";

// These two values are safe to ship in client-side / public code. Access is
// enforced server-side by Row Level Security, not by hiding the key.
// NEVER put the project's `service_role` key here — that one bypasses RLS.
const SUPABASE_URL = "https://sixrmhlzjthbanzfenpg.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpeHJtaGx6anRoYmFuemZlbnBnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NzExMzUsImV4cCI6MjA5NjQ0NzEzNX0.ildt1uboGwmBZPnfIWAkoMjbApi2lPuudocKzX_IjNY";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
