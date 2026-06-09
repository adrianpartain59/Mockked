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

- **Multiple devices** — **＋ Add Device** drops another phone into the scene and
  selects it. Switch or remove devices from the chip bar. Every control below
  acts on the *selected* device, so each phone can have its own screen, colour,
  and pose.
- **Upload to screen** — drop any image onto the selected phone's display. Each
  uploaded image is kept as a thumbnail in the **assets row**, so after *Reset
  screen* you can re-apply it (or apply it to another device) with one click.
  Fit modes: Cover / Contain / Stretch, plus a screen Brightness control.
- **Transform** — drag the on-canvas gizmo (Move `W`, Rotate `E`, Scale `R`) or
  use the **X / Y / Z** sliders, which control position, rotation, or scale of
  the selected device depending on the active mode. Drag empty space to orbit,
  scroll to zoom. *Reset transform* restores the default pose.
- **Phone color** — pick a realistic iPhone 17 Pro finish (Silver, Deep Blue,
  Cosmic Orange, Black, Natural) or any custom colour, and adjust the body
  Finish from matte to glossy. The aluminium is de-sparkled to a satin look.
- **Scene** — background colour, transparent background (on by default, for
  compositing), and environment-light intensity.
- **Presets** — apply a saved arrangement (every device's transform + the camera
  view; the screen image is not part of a preset). Shipped defaults live in
  `presets.js`. **Save preset** captures the current scene, keeps it as a local
  draft, and copies a ready-to-paste object to your clipboard (also logged to the
  console) — paste it into `DEFAULT_PRESETS` in `presets.js` to ship it to
  everyone. (Per-account presets will come later; for now defaults are hardcoded.)
- **Save** — the always-visible **Save** button (top-right of the panel) renders
  the scene and opens a **crop modal**: drag/resize the crop box, then download
  the cropped region as a PNG (transparent where the background is).
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
