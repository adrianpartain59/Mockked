// Default presets shipped to everyone.
//
// Each preset captures the camera view plus every device's transform
// (position / rotation in radians / scale). The screen image is intentionally
// NOT stored — users add their own after applying a preset.
//
// To add a default: arrange the scene in the app, click "Save preset", and the
// generated object is copied to your clipboard + logged to the console. Paste it
// into this array below.
export const DEFAULT_PRESETS = [
  {
    name: "Front",
    camera: { position: [0, 0.05, 0.6], target: [0, 0, 0] },
    devices: [{ pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }],
  },
];
