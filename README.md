# iPhone Mockup Generator

A small browser tool that puts your image onto a 3D iPhone 17 Pro, lets you pose
the phone, and exports a PNG. Built with [Three.js](https://threejs.org/) (loaded
from a CDN — no build step) using the two assets in this folder:

- `iphone-17-pro/source/iPhone 17 Pro.glb` — the phone model
- `studio_small_08_4k.exr` — studio HDRI used for realistic lighting & reflections

## Run

```bash
./start.sh          # serves on http://localhost:8001 and opens your browser
./start.sh 9000     # or pick a port
```

A local server is required (the browser can't load the `.glb`/`.exr` over `file://`).

## Features

- **Upload to screen** — drop any image onto the phone's display. Fit modes:
  Cover / Contain / Stretch, plus a screen Brightness control.
- **Transform & rotate** — drag the on-canvas gizmo (Move `W`, Rotate `E`,
  Scale `R`), or use the Rotate X/Y sliders. Drag empty space to orbit the
  camera, scroll to zoom. *Reset transform* restores the default pose.
- **Phone color** — pick a realistic iPhone 17 Pro finish (Silver, Deep Blue,
  Cosmic Orange, Black, Natural) or any custom colour, and adjust the body
  Finish from matte to glossy. The aluminium is de-sparkled to a satin look.
- **Scene** — pick a background colour, toggle a transparent background (for
  compositing), and adjust environment-light intensity.
- **Save** — export a PNG at 1× / 2× / 3× resolution. The gizmo is hidden
  automatically in the exported image.
- **Accounts & cloud sync** — sign up / sign in (email + password), then save
  mockups to the cloud and reload them later. Each saved mockup stores its
  settings (colour, transform, fit, brightness) plus the screen image.

## Cloud setup (Supabase)

Accounts and saved mockups are backed by [Supabase](https://supabase.com) (free
tier). The project URL and **anon** key live in `supabase.js` — these are safe to
commit; access is enforced server-side by Row Level Security.

One-time setup in your Supabase project:

1. **Create the schema.** Open *SQL Editor → New query*, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the
   `mockups` table, its RLS policies, and a private `mockups` storage bucket.
2. **Simplest auth flow.** Go to *Authentication → Sign In / Providers → Email*
   and turn **off** "Confirm email" so sign-up logs you straight in. (Leave it on
   if you'd rather verify addresses — then set *Authentication → URL
   Configuration → Site URL* to your deployed URL so the confirmation link works.)

## Files

- `index.html` — markup & control panel
- `styles.css` — UI styling
- `app.js` — Three.js scene, model/material handling, export, auth & cloud sync
- `supabase.js` — Supabase client (public URL + anon key)
- `supabase/schema.sql` — database table, RLS policies, and storage bucket
