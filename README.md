# Mockup Studio

A browser tool that puts your image onto a 3D iPhone 17 Pro, lets you pose
the phone, and exports a PNG. The UI is a set of floating glass panels over a
full-bleed black stage: a top bar (project title, account, Save / Export), a
left tool rail (Move / Rotate / gizmo visibility), and a right inspector
(device chips + Screen / Background / Transform / Appearance / Presets). Built with [Three.js](https://threejs.org/) (loaded
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

- **Multiple devices** — **＋ Add** (top of the inspector) drops another device
  into the scene and selects it. Switch or remove devices from the chip strip.
  Every control acts on the *selected* device, so each phone can have its own
  screen, colour, and pose.
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
  view; the screen image is not part of a preset). **Save preset** writes a
  *shared* preset to Supabase (`shared_presets` table), so everyone gets it
  immediately — no code edit needed. A couple of base defaults are also hardcoded
  in `presets.js` as a fallback. Run [`supabase/presets.sql`](supabase/presets.sql)
  once to create the shared table. (Per-account presets can come later; for now
  shared presets are open for anyone to add/remove — see the SQL to lock down.)
- **Animation** — a Rotato-style timeline dock sits under the stage. A keyframe
  snapshots the *whole scene* (camera + every device's transform): pose the
  scene, press **Add keyframe** (`K`), move the playhead, pose again. Playback
  tweens between snapshots (quaternion slerp) with per-keyframe easing (click a
  diamond to pick Ease / Ease-in / Ease-out / Linear, drag it to retime, `Space`
  plays). Keyframe times are normalized, so the **Duration** field stretches the
  whole animation. The **Animate** menu has 7 presets built from the current
  pose: Hero Orbit, Showcase Sweep, Pop In, Float, Swing, Dolly Reveal, and
  Slide & Settle. Animations save with cloud mockups.
- **Export** — the top-bar button renders the scene and opens a **crop modal**:
  drag/resize the crop box, then download the cropped region. Stills export as
  transparent PNG; when the timeline has keyframes (or a screen plays a video
  clip) the button becomes **Export Video** and records a transparent ~4K WebM
  of the animation — ready for ads.
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
