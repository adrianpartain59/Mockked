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
- **Animation timeline** — a Rotato-style dock under the stage with three
  composable layers:
  - **Animation clips** (Animations lane) — per-device procedural presets
    (Hero Orbit, Showcase Sweep, Pop In, Rise Up, Fly In Right, Float, Swing,
    Dolly Reveal, Slide & Settle) added as bars via **＋ Add animation**. Drag a
    bar to retime it, drag its edges to stretch/compress, sequence several one
    after another (bars snap to neighbours and the playhead), or overlap them to
    sum their motion. Each preset samples independent per-channel curves
    (`chan()` in `app.js`) so e.g. X can decelerate while Y accelerates; clips
    bring their own natural duration and the timeline auto-extends to fit.
  - **Screen media clips** (Screen lane) — sequence images/videos on a device's
    screen over time via **＋ Add media**; the bar shows the media thumbnail and
    the screen reverts to its base content outside the clips. A **video clip
    plays once** from the moment its bar starts, then **holds its last frame**
    for the rest of the bar — so to make a video kick in at a beat and then
    freeze, drop the clip at that point and stretch its right edge. Selecting a
    video clip reveals a **Plays once / Loops** toggle in the toolbar if you'd
    rather it repeat within the bar.
  - **Scene keyframes** (diamonds on the track) — manual whole-scene snapshots:
    pose, press **Add keyframe** (`K`), move the playhead, pose again. Tweens
    use quaternion slerp with per-keyframe easing. Keyframe times are
    normalized (they stretch with **Duration**); clips keep absolute timing.

  Clips are specific to the *selected device* — the lane header shows whose
  clips you're editing. Dragging/resizing clips **snaps** to the ¼ / ½ / 1-second
  grid (and magnetically to neighbouring clip edges and the playhead) when the
  magnet toggle is on; turn it off for free placement. The timeline **zooms**
  (−/＋ buttons or ⌘-scroll) centered on the playhead. `Space` plays, `Delete`
  removes the selected clip/keyframe. **Clear** restores the scene (pose *and*
  screens) to exactly how it was before animating; moving a device while paused
  re-anchors the animation around the new pose. Keyframes + animation clips save
  with cloud mockups (screen clips reference session uploads and aren't persisted
  yet).
- **Export** — the top-bar button renders the scene and opens a **crop modal**:
  drag/resize the crop box, then download the cropped region. Stills export as
  transparent PNG; when the timeline has keyframes (or a screen plays a video
  clip) the button becomes **Export Video** and records a transparent ~4K WebM
  of the animation — ready for ads.
- **Accounts & cloud sync** — sign up / sign in (email + password), then save
  mockups to the cloud and reload them later. Each saved mockup stores its
  settings (colour, transform, fit, brightness) plus the screen image. **Save**
  updates the project you're currently editing (loaded or previously saved)
  rather than creating a duplicate; it only starts a new record for a fresh,
  never-saved project.

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
