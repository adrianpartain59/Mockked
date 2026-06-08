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

## Files

- `index.html` — markup & control panel
- `styles.css` — UI styling
- `app.js` — Three.js scene, model/material handling, export
