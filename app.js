import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { supabase } from "./supabase.js";
import { DEFAULT_PRESETS } from "./presets.js";


// =====================================================================
// Device type registry
// =====================================================================
const DEVICE_TYPES = [
  {
    id: "iphone17pro",
    name: "iPhone 17 Pro",
    icon: "📱",
    modelUrl: "iphone-17-pro/source/iPhone%2017%20Pro.glb",
    loader: "gltf",
    targetSize: 0.16,
    screenAspect: 1206 / 2622,
    defaultColor: "#4a4a50",
    defaultFinish: 0.42,
  },
  {
    id: "applewatchultra2",
    name: "Apple Watch Ultra 2",
    icon: "⌚",
    modelUrl: "apple_watch_ultra_2.glb",
    loader: "gltf",
    // A real Apple Watch Ultra (~49mm) is roughly a third of an iPhone (~150mm),
    // so it's scaled down well below the phone's targetSize to read at true scale.
    targetSize: 0.07,
    screenAspect: 410 / 502,
    defaultColor: "#2b2b2e",
    defaultFinish: 0.3,
    // This Sketchfab GLB has obfuscated mesh/material names, so the display panel
    // can't be matched by a semantic name like the iPhone's. It's the self-lit
    // material that carries the baked watch-face on its emissiveMap.
    screenMatName: "edYkGGAdRWeopLP",
    // The Watch GLB's display UVs aren't U-mirrored like the iPhone's, but they
    // are flipped along V — so an uploaded image needs a vertical flip and no
    // horizontal flip to land upright.
    screenNoMirrorU: true,
    screenMirrorV: true,
  },
];

const DEFAULT_COLOR = "#4a4a50";
const DEFAULT_FINISH = 0.42;
const DEFAULT_DRAMA = 1; // scene lighting contrast: 0 = soft/flat, 1 = high-contrast, up to 3 = extreme
const MAX_DRAMA = 3;
const DEVICE_SPACING = 0.14; // x-offset between devices so they don't overlap

const canvas = document.getElementById("stage");
const statusEl = document.getElementById("status");
const loadingEl = document.getElementById("loading");
const setStatus = (m) => (statusEl.textContent = m);
const $ = (id) => document.getElementById(id);

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true, // lets us read the canvas for export at any time
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// Khronos PBR-neutral tone mapping. Designed for product/ecommerce shots: it
// preserves saturation and contrast instead of the milky highlight roll-off that
// ACES Filmic gives, so the device reads punchy rather than dull. (Requires
// three r162+.)
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// Render-on-demand flag. Declared up here (not in the render-loop section below)
// because applyDrama() and the startup device build both call render() during
// module initialization, which would otherwise hit this `let` in its temporal
// dead zone. render() only flags; animate() does the actual draw.
let needsRender = true;

// --- Scene & camera ---
const scene = new THREE.Scene();
scene.background = null; // transparent by default

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
camera.position.set(0, 0.05, 0.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.15;
controls.maxDistance = 4;
controls.enableRotate = false;
controls.enablePan = true;
controls.screenSpacePanning = true;
// Rotation is disabled, so bind the left mouse button to pan (its default is
// rotate, which would do nothing). Keep right-drag and touch panning working too.
controls.mouseButtons = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN,
};
controls.touches = {
  ONE: THREE.TOUCH.PAN,
  TWO: THREE.TOUCH.DOLLY_PAN,
};

// --- Transform gizmo ---
const transform = new TransformControls(camera, renderer.domElement);
transform.setSize(0.8);
scene.add(transform);
transform.addEventListener("dragging-changed", (e) => {
  controls.enabled = !e.value;
});
transform.addEventListener("objectChange", () => {
  refreshTransformSliders();
  render();
});
transform.addEventListener("change", render);

// --- Lighting: a clean, procedural studio environment ---
// Professional mockup tools light products with a soft, neutral studio rig, not a
// photographic HDRI. A real-world HDRI carries high-frequency detail that a glossy
// surface mirrors as random glare/grit, and it throws hard hotspots at certain
// camera angles. Instead we bake a smooth gradient "studio" (a bright horizon
// sweep plus two soft softboxes) into the environment. That gives a clean,
// controllable reflection that reads as an authentic polished-metal finish from
// every angle, with no random glare.
function makeStudioEnvTexture() {
  const w = 1024, h = 512;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");

  // Vertical gradient: dim zenith → bright eye-level sweep → dim floor. The bright
  // band sits at the horizon so it sweeps cleanly across the phone's rounded edge.
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0.0, "#33333a");
  g.addColorStop(0.34, "#9a9aa4");
  g.addColorStop(0.5, "#ffffff");
  g.addColorStop(0.66, "#b4b4be");
  g.addColorStop(1.0, "#3c3c44");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Two soft "softbox" highlights give clean specular streaks on the metal edge.
  ctx.globalCompositeOperation = "lighter";
  for (const cx of [0.22, 0.7]) {
    const x = cx * w, y = h * 0.44, r = w * 0.15;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, "rgba(255,255,255,0.85)");
    rg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalCompositeOperation = "source-over";

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const pmrem = new THREE.PMREMGenerator(renderer);
{
  const envSrc = makeStudioEnvTexture();
  scene.environment = pmrem.fromEquirectangular(envSrc).texture;
  envSrc.dispose();
  pmrem.dispose();
}

// A directional key light plus an ambient fill. The "Drama" control drives the
// ratio between them (see applyDrama): a strong key with little fill makes the
// device fall from bright into shadow across its surface — the standard
// product-photography lever for a dramatic look — while a softer key with more
// fill reads flat and even.
const key = new THREE.DirectionalLight(0xffffff, 1);
key.position.set(1, 2, 2);
scene.add(key);
const fill = new THREE.AmbientLight(0xffffff, 0.2);
scene.add(fill);

// Map a single 0..1 "drama" amount onto the key/fill ratio and the environment
// brightness. Higher drama = stronger key, less fill, and a darker environment
// (which also makes the glossy edge highlights pop against the body).
let drama = DEFAULT_DRAMA;
function applyDrama(t) {
  drama = THREE.MathUtils.clamp(t, 0, MAX_DRAMA);
  // Lerp factors extrapolate past 1 for the 1..3 "extreme" range; clamp the
  // results so intensities never go negative or unreasonably bright.
  key.intensity = Math.max(0, THREE.MathUtils.lerp(0.55, 3.2, drama));
  fill.intensity = Math.max(0, THREE.MathUtils.lerp(0.32, 0.04, drama));
  scene.environmentIntensity = Math.max(0, THREE.MathUtils.lerp(1.15, 0.55, drama));
  render();
}

// =====================================================================
// Devices
// =====================================================================
const templateModels = new Map();   // typeId → { scene, center, scale }
const deviceTypeCounts = new Map(); // typeId → running label counter
const devices = [];
let activeDevice = null;
let activeKind = "device"; // what the gizmo + X/Y/Z controls drive: 'device' | 'background'
let deviceCounter = 0;
let mode = "translate";

async function loadTemplate(type) {
  if (templateModels.has(type.id)) return templateModels.get(type.id);
  return new Promise((resolve, reject) => {
    const onLoad = (root) => {
      const box = new THREE.Box3().setFromObject(root);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const size = box.getSize(new THREE.Vector3());
      const scale = type.targetSize / Math.max(size.x, size.y, size.z);
      const tmpl = { scene: root, center, scale };
      templateModels.set(type.id, tmpl);
      resolve(tmpl);
    };
    if (type.loader === "gltf") {
      new GLTFLoader().load(
        type.modelUrl,
        (gltf) => onLoad(gltf.scene),
        (e) => { if (e.total) setStatus(`Loading model… ${Math.round((e.loaded / e.total) * 100)}%`); },
        reject
      );
    } else {
      new FBXLoader().load(type.modelUrl, onLoad, undefined, reject);
    }
  });
}

// Load iPhone template and add the first device on startup.
loadTemplate(DEVICE_TYPES[0]).then((tmpl) => {
  loadingEl.classList.add("hidden");
  _buildAndAddDevice(DEVICE_TYPES[0], tmpl);
  setStatus("Ready. Upload an image for the screen, or ＋ Add Device.");
  render();
}).catch((err) => {
  console.error("startup build failed:", err);
  loadingEl.textContent = "Failed to load model.";
  setStatus("Failed to load the .glb model.");
});

// Turn the GLB's standard aluminium material into a polished metal with a glossy
// clearcoat — the bright, clean specular edge you see on real iPhone renders. The
// clearcoat lays a glossy layer on top of the base colour, so coloured finishes
// still read while the edge stays shiny. The normal map is dropped so the
// reflection stays smooth instead of breaking up into sparkle.
function toGlossyMetal(std) {
  const p = new THREE.MeshPhysicalMaterial({
    color: std.color ? std.color.clone() : new THREE.Color(0x4a4a50),
    metalness: 0.6,
    roughness: 0.38,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    envMapIntensity: 1.15,
  });
  p.name = std.name;
  return p;
}

// Build one independent device instance from a loaded template. Named iPhone
// materials get their specific treatment; everything else falls back to a generic
// glossy-metal path so any device type looks polished out of the box.
function buildDevice(type, tmpl) {
  const model = tmpl.scene.clone(true);
  // Each name can appear on more than one mesh (cloning makes separate material
  // copies), so collect *all* instances or some surfaces won't get recoloured.
  const bodyMaterials = { frame: [], antenna: [], back: [] };
  let screenMaterial = null;
  let defaultScreenMaps = null;

  model.traverse((o) => {
    if (!o.isMesh) return;
    const wasArray = Array.isArray(o.material);
    const mats = (wasArray ? o.material : [o.material]).map((src) => {
      if (!src) return src;
      let m = src.clone();
      const n = m.name.toLowerCase();
      // Only the actual lit display panel becomes self-lit. The loose
      // screen/display match must exclude bezels ("Display Frame") and the
      // off-state panel ("OLED off") — otherwise those meshes glow as bright
      // outlines around the screen and the front/back cameras.
      const isScreen =
        (type.screenMatName && m.name === type.screenMatName) ||
        ((n === "oled" || n.includes("screen") || n.includes("display")) &&
          !n.includes("frame") &&
          !n.includes("off"));
      if (isScreen) {
        defaultScreenMaps = { map: m.map, emissiveMap: m.emissiveMap, color: m.color.clone() };
        // Replace the GLB's MeshStandardMaterial with a MeshBasicMaterial for the
        // screen. MeshBasicMaterial has no IBL/PBR at all — it renders map×color
        // directly, so the environment can never bleed through.
        //
        // Why not keep MeshStandardMaterial with envMapIntensity=0?
        // In Three.js r166, when material.envMap===null and scene.environment is
        // set, the renderer overwrites the shader's envMapIntensity uniform with
        // scene.environmentIntensity in the per-object render loop, completely
        // ignoring material.envMapIntensity. MeshBasicMaterial sidesteps this
        // entirely — it has no environment-map code path at all.
        const basic = new THREE.MeshBasicMaterial({
          map: m.emissiveMap || m.map,
          color: 0xffffff,
          toneMapped: false,
          transparent: m.transparent,
          opacity: m.opacity,
          // The OLED panel's geometry winds so its front face points into the
          // phone (away from the camera). MeshStandardMaterial happened to show
          // it anyway, but MeshBasicMaterial honors FrontSide culling strictly,
          // which rendered the screen as nothing. DoubleSide draws it regardless
          // of facing so the display (and any uploaded image) is always visible.
          side: THREE.DoubleSide,
        });
        basic.name = m.name;
        screenMaterial = basic;
        return basic;
      } else if (n === "glass") {
        // Front cover glass. The GLB's MeshStandardMaterial still responds to
        // the directional key + ambient fill even with envMapIntensity=0, so at
        // any opacity it alpha-blends a lit near-white veil over the screen and
        // lifts the blacks. Swap it for an unlit MeshBasicMaterial at zero
        // opacity: it receives no light at all, so the screen underneath keeps
        // its full contrast.
        const clearGlass = new THREE.MeshBasicMaterial({
          color: 0x000000,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        clearGlass.name = m.name;
        return clearGlass;
      } else if (n === "anodized aluminum") {
        m = toGlossyMetal(m); // polished edge with a clearcoat sheen
        bodyMaterials.frame.push(m);
      } else if (n === "plastic antena") {
        bodyMaterials.antenna.push(m);
      } else if (n === "frosted glass") {
        bodyMaterials.back.push(m);
      } else {
        // Preserve all other materials (camera lenses, LEDs, ports, screws,
        // speaker mesh, etc.) exactly as the GLB authored them. Converting
        // these to toGlossyMetal painted the camera island with the body
        // colour and destroyed the lens appearance.
      }
      return m;
    });
    o.material = wasArray ? mats : mats[0];
  });
  // Flatten the remaining body normal maps. Their fine surface detail is what
  // turned a glossy surface into sparkle/grit; against the clean studio
  // environment we don't need it. (The frame already dropped its map in
  // toGlossyMetal.)
  for (const m of [...bodyMaterials.antenna, ...bodyMaterials.back]) {
    if (m.normalScale) m.normalScale.set(0, 0);
  }

  // Center + scale + face the screen forward, inside a pivot so the outer group
  // transform (driven by gizmo / sliders) starts at identity.
  // The iPhone GLB screen faces -Z so we flip it to face the camera; the Apple
  // Watch FBX is already two flat planes facing +Z, so no Y-rotation needed.
  model.position.copy(tmpl.center).negate();
  const pivot = new THREE.Group();
  pivot.scale.setScalar(tmpl.scale);
  pivot.rotation.y = type.id === "applewatchultra2" ? 0 : Math.PI;
  pivot.add(model);
  const group = new THREE.Group();
  group.add(pivot);
  scene.add(group);

  const typeCount = (deviceTypeCounts.get(type.id) || 0) + 1;
  deviceTypeCounts.set(type.id, typeCount);

  const dev = {
    id: ++deviceCounter,
    type,
    typeCount,
    group,
    model,
    screenMaterial,
    bodyMaterials,
    defaultScreenMaps,
    screenBlob: null,
    uploadedTexture: null,
    screenVideo: null,        // <video> element when the screen is a clip
    screenVideoAsset: null,   // the asset (with live trim metadata) driving it
    screenIsVideo: false,
    uploadedImageSize: { w: 1, h: 1 },
    settings: {
      color: type.defaultColor,
      finish: type.defaultFinish,
      fit: "cover",
      brightness: 1,
      warmth: 0,
    },
  };
  devices.push(dev);
  applyDeviceColor(dev, dev.settings.color);
  applyDeviceFinish(dev, dev.settings.finish);
  applyScreenWarmth(dev, dev.settings.warmth);
  applyDeviceBrightness(dev, dev.settings.brightness);
  return dev;
}

function _buildAndAddDevice(type, tmpl) {
  const dev = buildDevice(type, tmpl);
  dev.group.position.x = (devices.length - 1) * DEVICE_SPACING;
  selectDevice(dev);
  renderDeviceBar();
  render();
  return dev;
}

// =====================================================================
// Device picker modal
// =====================================================================
function openDevicePicker() {
  const modal = $("devicePickerModal");
  const grid = $("devicePickerGrid");
  grid.innerHTML = "";
  for (const type of DEVICE_TYPES) {
    const card = document.createElement("div");
    card.className = "device-type-card";
    const iconEl = document.createElement("div");
    iconEl.className = "device-card-icon";
    iconEl.textContent = type.icon;
    const nameEl = document.createElement("div");
    nameEl.className = "device-card-name";
    nameEl.textContent = type.name;
    card.append(iconEl, nameEl);
    card.addEventListener("click", async () => {
      modal.hidden = true;
      setStatus(`Loading ${type.name}\u2026`);
      try {
        const tmpl = await loadTemplate(type);
        _buildAndAddDevice(type, tmpl);
        setStatus(`Added ${type.name}.`);
      } catch {
        setStatus(`Failed to load ${type.name} model.`);
      }
    });
    grid.appendChild(card);
  }
  modal.hidden = false;
}

function removeDevice(dev) {
  if (devices.length <= 1) return; // always keep at least one
  stopDeviceVideo(dev);
  scene.remove(dev.group);
  const i = devices.indexOf(dev);
  devices.splice(i, 1);
  if (activeDevice === dev) selectDevice(devices[Math.max(0, i - 1)]);
  renderDeviceBar();
  updateSaveButtonLabel();
  render();
}

function selectDevice(dev) {
  activeDevice = dev;
  activeKind = "device";
  transform.attach(dev.group);
  transform.enabled = $("gizmoToggle").checked;
  transform.visible = $("gizmoToggle").checked;
  syncControlsToDevice();
  renderDeviceBar();
  render();
}

// Select the background layer as the transform target so the gizmo and the
// X/Y/Z controls drive it (Z = zoom in/out).
function selectBackground() {
  if (!bgLayer.active || !bgLayer.group) return;
  activeKind = "background";
  transform.attach(bgLayer.group);
  transform.enabled = $("gizmoToggle").checked;
  transform.visible = $("gizmoToggle").checked;
  refreshTransformSliders();
  renderDeviceBar();
  render();
}

function renderDeviceBar() {
  const bar = $("deviceBar");
  // Keep the persistent Add Device button; rebuild only the chips after it.
  bar.querySelectorAll(".device-chip").forEach((c) => c.remove());
  devices.forEach((dev) => {
    const chip = document.createElement("div");
    chip.className = "device-chip" + (activeKind === "device" && dev === activeDevice ? " active" : "");
    const icon = document.createElement("span");
    icon.className = "chip-icon";
    icon.textContent = dev.type.icon;
    const label = document.createElement("span");
    label.textContent = `${dev.type.name} ${dev.typeCount}`;
    label.addEventListener("click", () => selectDevice(dev));
    chip.appendChild(icon);
    chip.appendChild(label);
    if (devices.length > 1) {
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.title = "Remove device";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        removeDevice(dev);
      });
      chip.appendChild(x);
    }
    chip.addEventListener("click", () => selectDevice(dev));
    bar.appendChild(chip);
  });

  // Background layer chip (only when a background is active).
  if (bgLayer.active) {
    const chip = document.createElement("div");
    chip.className = "device-chip" + (activeKind === "background" ? " active" : "");
    const icon = document.createElement("span");
    icon.className = "chip-icon";
    icon.textContent = "🖼";
    const label = document.createElement("span");
    label.textContent = "Background";
    chip.append(icon, label);
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.title = "Remove background";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      clearBackground();
    });
    chip.appendChild(x);
    chip.addEventListener("click", selectBackground);
    bar.appendChild(chip);
  }
}

$("addDevice").addEventListener("click", openDevicePicker);
$("devicePickerCancel").addEventListener("click", () => {
  $("devicePickerModal").hidden = true;
});

// =====================================================================
// Click-to-select: clicking any device in the viewport selects it.
// Only fires when the pointer hasn't moved (i.e. not an orbit drag).
// =====================================================================
const _raycaster = new THREE.Raycaster();
const _rayPointer = new THREE.Vector2();
let _pointerDownPos = null;

canvas.addEventListener("pointerdown", (e) => {
  _pointerDownPos = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener("pointerup", (e) => {
  if (!_pointerDownPos) return;
  const dx = e.clientX - _pointerDownPos.x;
  const dy = e.clientY - _pointerDownPos.y;
  _pointerDownPos = null;
  if (Math.sqrt(dx * dx + dy * dy) > 4) return; // was a drag, not a click
  if (transform.dragging) return; // gizmo interaction

  const rect = canvas.getBoundingClientRect();
  _rayPointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _rayPointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _raycaster.setFromCamera(_rayPointer, camera);

  // Devices take priority over the background plane (which can sit in front of
  // them once zoomed), so test devices first and only fall back to the plane.
  const meshes = [];
  for (const dev of devices) dev.group.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const hits = _raycaster.intersectObjects(meshes, false);
  if (hits.length) {
    let node = hits[0].object;
    while (node) {
      const dev = devices.find((d) => d.group === node);
      if (dev) { if (dev !== activeDevice || activeKind !== "device") selectDevice(dev); return; }
      node = node.parent;
    }
    return;
  }
  if (bgLayer.active && bgLayer.mesh) {
    const bgHits = _raycaster.intersectObject(bgLayer.mesh, false);
    if (bgHits.length && activeKind !== "background") selectBackground();
  }
});

// Push the active device's settings/transform back into the controls.
function syncControlsToDevice() {
  if (!activeDevice) return;
  const s = activeDevice.settings;
  $("bodyColor").value = s.color;
  updateActiveSwatch(s.color);
  $("finish").value = s.finish;
  $("finishN").value = s.finish;
  refreshTransformSliders();
}

// =====================================================================
// Screen image + assets library
// =====================================================================
// Uploaded asset library. Each entry:
//   { id, name, type:'image'|'video', url, blob?, path?, remote, trim }
// `remote` assets live in the user's Supabase account; `url` is a signed URL and
// `blob` is fetched lazily. Session-only uploads (signed-out) keep an objectURL.
const assets = [];

// Update the texture on a screen MeshBasicMaterial. MeshBasicMaterial renders
// map×color with no IBL or direct-light contribution, so the image always
// displays at its true pixel values regardless of scene lighting or environment.
function configureEmissiveScreen(m, tex) {
  m.map = tex || null;
  m.color.set(0xffffff);
  m.toneMapped = false;
  // Watch screen plane starts transparent; reveal when content is set.
  if (m.transparent) m.opacity = tex ? 1 : 0;
  m.needsUpdate = true;
}

function applyDeviceScreenTexture(dev) {
  const m = dev.screenMaterial;
  if (!m || !dev.uploadedTexture) return;
  configureEmissiveScreen(m, dev.uploadedTexture);
}

function applyDeviceFit(dev) {
  const t = dev.uploadedTexture;
  if (!t) return;
  const fitMode = dev.settings.fit;
  const screenAspect = dev.type.screenAspect;
  const imgAspect = dev.uploadedImageSize.w / dev.uploadedImageSize.h;
  t.repeat.set(1, 1);
  t.offset.set(0, 0);
  const wider = imgAspect > screenAspect;
  if (fitMode === "cover") {
    if (wider) {
      const r = screenAspect / imgAspect;
      t.repeat.set(r, 1);
      t.offset.set((1 - r) / 2, 0);
    } else {
      const r = imgAspect / screenAspect;
      t.repeat.set(1, r);
      t.offset.set(0, (1 - r) / 2);
    }
  } else if (fitMode === "contain") {
    if (wider) {
      const r = imgAspect / screenAspect;
      t.repeat.set(1, r);
      t.offset.set(0, (1 - r) / 2);
    } else {
      const r = screenAspect / imgAspect;
      t.repeat.set(r, 1);
      t.offset.set((1 - r) / 2, 0);
    }
  }
  // The iPhone GLB's screen UVs are mirrored along U, so flip to compensate.
  if (!dev.type.screenNoMirrorU) t.repeat.x *= -1;
  // The Watch GLB's display UVs are flipped along V instead, so an uploaded image
  // lands upside-down without this. (The iPhone's V is already upright.)
  if (dev.type.screenMirrorV) t.repeat.y *= -1;
  render();
}

// Stop and detach any video currently driving a device's screen. Called before
// applying a still image, removing a clip, resetting, or tearing the device down.
function stopDeviceVideo(dev) {
  if (!dev.screenVideo) return;
  try { dev.screenVideo.pause(); } catch {}
  dev.screenVideo.removeAttribute("src");
  dev.screenVideo.load();
  dev.screenVideo = null;
  dev.screenVideoAsset = null;
  dev.screenIsVideo = false;
}

// True if any device's screen is currently showing a video clip.
function isVideoMockup() {
  return devices.some((d) => d.screenIsVideo);
}

// Apply a video asset to a device's screen as a looping VideoTexture. The clip
// loops within the asset's (live) trim range, so re-trimming takes effect without
// a rebuild. The screen stays self-lit (MeshBasicMaterial) and the background
// stays transparent, exactly like the still-image path.
function applyScreenVideoToDevice(dev, asset) {
  stopDeviceVideo(dev);
  dev.screenBlob = null; // the cloud-save path only handles still images

  const video = document.createElement("video");
  video.src = asset.url;
  video.muted = true;       // required for autoplay
  video.loop = true;        // native loop for the untrimmed case; the timeupdate
                            // handler below additionally enforces a trim window
  video.playsInline = true;
  video.crossOrigin = "anonymous";

  const tex = new THREE.VideoTexture(video);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.center.set(0.5, 0.5);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;

  video.addEventListener("loadedmetadata", () => {
    dev.uploadedImageSize = { w: video.videoWidth || 1, h: video.videoHeight || 1 };
    applyDeviceFit(dev);
    const start = dev.screenVideoAsset?.trim?.start ?? 0;
    if (video.currentTime < start) video.currentTime = start;
    video.play().catch(() => {});
    render();
  });

  // Loop within the trim window. Reads the asset's trim live so editing or
  // reverting the trim is reflected on the next frame without a rebuild. The
  // rewind has to keep the element playing: at the true end of an untrimmed clip
  // the browser fires `ended` and pauses, so we also restart on `ended`.
  const restartIfNeeded = () => {
    const tr = dev.screenVideoAsset?.trim;
    const start = tr?.start ?? 0;
    const end = tr?.end ?? (video.duration || Infinity);
    if (video.currentTime >= end || video.currentTime < start - 0.05) {
      video.currentTime = start;
      if (video.paused) video.play().catch(() => {});
    }
  };
  video.addEventListener("timeupdate", restartIfNeeded);
  video.addEventListener("ended", () => {
    const start = dev.screenVideoAsset?.trim?.start ?? 0;
    video.currentTime = start;
    video.play().catch(() => {});
  });

  dev.screenVideo = video;
  dev.screenVideoAsset = asset;
  dev.screenIsVideo = true;
  dev.uploadedTexture = tex;
  applyDeviceScreenTexture(dev);
  updateSaveButtonLabel();
  setStatus("Video applied to screen. Click it in assets to trim.");
}

// Load an image (File/Blob) onto a device's screen.
function applyScreenBlobToDevice(dev, blob) {
  stopDeviceVideo(dev);
  updateSaveButtonLabel();
  dev.screenBlob = blob;
  const url = URL.createObjectURL(blob);
  new THREE.TextureLoader().load(url, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.center.set(0.5, 0.5);
    // The screen's U-mirror flip (applyDeviceFit) pushes UVs outside [0,1] on
    // atlassed models like the Watch GLB; RepeatWrapping mirrors cleanly where
    // the default ClampToEdge would smear the edge pixels across the panel.
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    dev.uploadedImageSize = { w: tex.image.width, h: tex.image.height };
    dev.uploadedTexture = tex;
    applyDeviceScreenTexture(dev);
    applyDeviceFit(dev);
    URL.revokeObjectURL(url);
    setStatus("Screen image applied.");
    render();
  });
}

// Fetch (and cache) an asset's underlying blob. Remote/account assets only carry
// a signed URL until something needs the bytes.
async function getAssetBlob(asset) {
  if (asset.blob) return asset.blob;
  asset.blob = await (await fetch(asset.url)).blob();
  return asset.blob;
}

// Apply any library asset (image or video) to the active device's screen.
async function applyAssetToScreen(asset) {
  if (!activeDevice) return;
  if (asset.type === "video") {
    applyScreenVideoToDevice(activeDevice, asset);
  } else {
    const blob = await getAssetBlob(asset);
    applyScreenBlobToDevice(activeDevice, blob);
  }
}

function renderAssets() {
  const row = $("assetRow");
  row.innerHTML = "";
  for (const a of assets) {
    if (a.type === "video") {
      const wrap = document.createElement("div");
      wrap.className = "asset-thumb video";
      wrap.title = "Click to trim / edit video";
      const vid = document.createElement("video");
      vid.src = a.url;
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = "metadata";
      const badge = document.createElement("span");
      badge.className = "asset-badge";
      badge.textContent = a.trim ? "✂" : "▶";
      wrap.append(vid, badge);
      wrap.addEventListener("click", () => openTrimEditor(a));
      row.appendChild(wrap);
    } else {
      const img = document.createElement("img");
      img.className = "asset-thumb";
      img.src = a.url;
      img.title = "Apply to selected device";
      img.addEventListener("click", () => applyAssetToScreen(a));
      row.appendChild(img);
    }
  }
}

$("clearScreen").addEventListener("click", () => {
  const dev = activeDevice;
  if (!dev || !dev.defaultScreenMaps) return;
  stopDeviceVideo(dev);
  configureEmissiveScreen(dev.screenMaterial, dev.defaultScreenMaps.emissiveMap || dev.defaultScreenMaps.map);
  dev.uploadedTexture = null;
  dev.screenBlob = null;
  updateSaveButtonLabel();
  setStatus("Screen reset. Re-add an image or video from the assets row.");
  render();
});

// =====================================================================
// Background layer — a textured plane that lives in the scene behind the
// devices. Because it's a real scene object it's selectable and driven by the
// same gizmo + X/Y/Z transform controls as a device (e.g. push it along Z to
// zoom it in/out), and it's captured automatically by the PNG/video export.
// =====================================================================
const BG_HOME_Z = -0.35; // resting distance behind the devices (which sit near z=0)

// The background plane lives in its own scene so it can be drawn in a separate
// first pass and never participates in the devices' depth buffer.
const bgScene = new THREE.Scene();

const bgLayer = {
  group: null,
  mesh: null,
  material: null,
  texture: null,
  asset: null,
  active: false,
  imageSize: { w: 1, h: 1 },
};

function ensureBgLayer() {
  if (bgLayer.group) return;
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({
    toneMapped: false,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  const group = new THREE.Group();
  group.position.set(0, 0, BG_HOME_Z);
  group.add(mesh);
  group.visible = false;
  // The plane lives in its own scene rendered in a first pass (see renderFrame),
  // so it always sits behind the devices no matter how it's transformed — even
  // when zoomed (pushed along Z) past them toward the camera.
  bgScene.add(group);
  bgLayer.group = group;
  bgLayer.mesh = mesh;
  bgLayer.material = mat;
}

// Size the plane to more than fill the camera frustum at its resting distance,
// and cover-fit the texture so the image keeps its aspect ratio (no stretch).
function fitBgPlane() {
  if (!bgLayer.group) return;
  const dist = Math.abs(camera.position.z - BG_HOME_Z);
  const vH = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist;
  const vW = vH * camera.aspect;
  const overscan = 1.8; // headroom so panning / zooming out doesn't reveal edges
  bgLayer.mesh.scale.set(vW * overscan, vH * overscan, 1);
  const planeAspect = vW / vH;
  const t = bgLayer.texture;
  if (t) {
    const imgA = bgLayer.imageSize.w / bgLayer.imageSize.h;
    t.center.set(0.5, 0.5);
    t.repeat.set(1, 1);
    t.offset.set(0, 0);
    if (imgA > planeAspect) {
      const r = planeAspect / imgA;
      t.repeat.set(r, 1);
      t.offset.set((1 - r) / 2, 0);
    } else {
      const r = imgA / planeAspect;
      t.repeat.set(1, r);
      t.offset.set(0, (1 - r) / 2);
    }
  }
}

function setBackgroundFromAsset(asset) {
  ensureBgLayer();
  new THREE.TextureLoader().load(
    asset.url,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      if (bgLayer.texture) bgLayer.texture.dispose();
      bgLayer.texture = tex;
      bgLayer.asset = asset;
      bgLayer.imageSize = { w: tex.image.width, h: tex.image.height };
      bgLayer.material.map = tex;
      bgLayer.material.needsUpdate = true;
      bgLayer.active = true;
      bgLayer.group.visible = true;
      fitBgPlane();
      renderDeviceBar();
      selectBackground(); // select it so it can be moved/zoomed immediately
      setStatus("Background applied. Use the Z control to zoom it in/out.");
      render();
    },
    undefined,
    () => setStatus("Couldn't load that background image.")
  );
}

function clearBackground() {
  if (!bgLayer.active) return;
  bgLayer.active = false;
  if (bgLayer.group) bgLayer.group.visible = false;
  bgLayer.asset = null;
  if (activeKind === "background") selectDevice(activeDevice);
  renderDeviceBar();
  setStatus("Background removed.");
  render();
}

$("clearBackground").addEventListener("click", clearBackground);

// =====================================================================
// Asset import / library modal: drag-drop or pick files, browse uploaded assets,
// delete them. Uploads persist to the signed-in user's account (Supabase
// `user_assets` + `assets` storage bucket); signed-out uploads stay session-only.
// =====================================================================
const assetModal = $("assetModal");
const assetFileInput = $("assetFileInput");
const assetDropzone = $("assetDropzone");
const assetLibraryGrid = $("assetLibraryGrid");
let assetModalMode = "screen"; // 'screen' | 'background'
let currentUser = null;        // set by the auth state listener
let remoteAssetsLoaded = false;

function openAssetModal(mode) {
  assetModalMode = mode;
  $("assetModalTitle").textContent = mode === "background" ? "Import background image" : "Import to screen";
  $("dropzoneText").textContent = mode === "background"
    ? "Drag & drop an image here"
    : "Drag & drop an image or video here";
  // Backgrounds are images only; screens accept images and videos.
  assetFileInput.accept = mode === "background" ? "image/*" : "image/*,video/*";
  switchAssetTab("upload");
  renderAssetLibrary();
  assetModal.hidden = false;
  if (currentUser && !remoteAssetsLoaded) loadRemoteAssets();
}

function closeAssetModal() {
  assetModal.hidden = true;
}

function switchAssetTab(tab) {
  $("assetTabUpload").classList.toggle("active", tab === "upload");
  $("assetTabLibrary").classList.toggle("active", tab === "library");
  $("assetUploadPanel").hidden = tab !== "upload";
  $("assetLibraryPanel").hidden = tab !== "library";
  if (tab === "library") renderAssetLibrary();
}

// An asset is allowed for the current mode if its kind matches (background = image
// only). Returns true/false.
function assetAllowedForMode(asset) {
  return assetModalMode === "background" ? asset.type === "image" : true;
}

// Apply an asset per the modal's mode, then close.
function chooseAsset(asset) {
  if (!assetAllowedForMode(asset)) {
    setStatus("Backgrounds must be image files.");
    return;
  }
  if (assetModalMode === "background") {
    setBackgroundFromAsset(asset);
  } else if (asset.type === "video") {
    applyScreenVideoToDevice(activeDevice, asset);
  } else {
    applyAssetToScreen(asset);
  }
  closeAssetModal();
}

function renderAssetLibrary() {
  const grid = assetLibraryGrid;
  grid.innerHTML = "";
  const note = $("assetLibraryNote");
  const usable = assets.filter(assetAllowedForMode);
  if (!usable.length) {
    note.textContent = currentUser
      ? "No uploaded assets yet. Upload one to get started."
      : "No uploaded assets yet. Sign in to save uploads to your account.";
    return;
  }
  note.textContent = currentUser ? "" : "Sign in to save uploads to your account.";
  for (const a of usable) {
    const card = document.createElement("div");
    card.className = "asset-card";
    card.title = a.name || "asset";
    if (a.type === "video") {
      const v = document.createElement("video");
      v.src = a.url; v.muted = true; v.playsInline = true; v.preload = "metadata";
      card.appendChild(v);
      const badge = document.createElement("span");
      badge.className = "kind-badge";
      badge.textContent = "video";
      card.appendChild(badge);
    } else {
      const img = document.createElement("img");
      img.src = a.url;
      card.appendChild(img);
    }
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.title = "Delete from uploaded assets";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteAsset(a);
    });
    card.appendChild(del);
    card.addEventListener("click", () => chooseAsset(a));
    grid.appendChild(card);
  }
}

// Ingest one File: add to the library, persist to the account if signed in.
async function ingestFile(file) {
  const type = file.type.startsWith("video/") ? "video" : "image";
  const asset = {
    id: null,
    name: file.name || `${type}-${Date.now()}`,
    type,
    url: URL.createObjectURL(file),
    blob: file,
    path: null,
    remote: false,
    trim: null,
  };
  assets.push(asset);
  renderAssets();
  renderAssetLibrary();

  if (currentUser) {
    try {
      const ext = (file.name?.split(".").pop() || (type === "video" ? "webm" : "png")).toLowerCase();
      const path = `${currentUser.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("assets")
        .upload(path, file, { contentType: file.type || undefined, upsert: true });
      if (upErr) throw upErr;
      const { data: row, error: dbErr } = await supabase
        .from("user_assets")
        .insert({ user_id: currentUser.id, name: asset.name, mime: file.type || "", kind: type, path })
        .select()
        .single();
      if (dbErr) throw dbErr;
      asset.id = row.id;
      asset.path = path;
      asset.remote = true;
    } catch (err) {
      setStatus("Saved locally; account upload failed: " + (err.message || err));
    }
  }
  return asset;
}

// Handle a batch of picked/dropped files. Applies the first valid one to the
// current target (screen/background) and keeps the rest in the library.
async function handleIncomingFiles(fileList) {
  const files = [...fileList].filter((f) =>
    assetModalMode === "background" ? f.type.startsWith("image/") : (f.type.startsWith("image/") || f.type.startsWith("video/"))
  );
  if (!files.length) {
    setStatus(assetModalMode === "background" ? "Pick an image file." : "Pick an image or video file.");
    return;
  }
  setStatus("Uploading…");
  let first = null;
  for (const f of files) {
    const a = await ingestFile(f);
    if (!first) first = a;
  }
  renderAssetLibrary();
  if (first) chooseAsset(first);
}

async function deleteAsset(asset) {
  // Stop using it anywhere first.
  for (const d of devices) {
    if (d.screenVideoAsset === asset) {
      stopDeviceVideo(d);
      if (d.defaultScreenMaps) configureEmissiveScreen(d.screenMaterial, d.defaultScreenMaps.emissiveMap || d.defaultScreenMaps.map);
      d.uploadedTexture = null;
      d.screenBlob = null;
    }
  }
  if (bgLayer.active && bgLayer.asset === asset) clearBackground();
  const i = assets.indexOf(asset);
  if (i >= 0) assets.splice(i, 1);
  if (!asset.remote) URL.revokeObjectURL(asset.url);

  if (asset.remote && asset.id) {
    try {
      if (asset.path) await supabase.storage.from("assets").remove([asset.path]);
      await supabase.from("user_assets").delete().eq("id", asset.id);
    } catch (err) {
      setStatus("Removed locally; account delete failed: " + (err.message || err));
    }
  }
  renderAssets();
  renderAssetLibrary();
  updateSaveButtonLabel();
  render();
}

async function loadRemoteAssets() {
  if (!currentUser) return;
  const { data, error } = await supabase
    .from("user_assets")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    $("assetLibraryNote").textContent = "Couldn't load saved assets (run supabase/assets.sql?).";
    return;
  }
  remoteAssetsLoaded = true;
  for (const row of data || []) {
    if (assets.some((a) => a.id === row.id)) continue;
    const { data: signed } = await supabase.storage.from("assets").createSignedUrl(row.path, 3600);
    if (!signed?.signedUrl) continue;
    assets.push({
      id: row.id,
      name: row.name,
      type: row.kind === "video" ? "video" : "image",
      url: signed.signedUrl,
      blob: null,
      path: row.path,
      remote: true,
      trim: null,
    });
  }
  renderAssets();
  renderAssetLibrary();
}

// Wire up modal controls.
$("importScreen").addEventListener("click", () => openAssetModal("screen"));
$("importBackground").addEventListener("click", () => openAssetModal("background"));
$("assetModalClose").addEventListener("click", closeAssetModal);
$("assetTabUpload").addEventListener("click", () => switchAssetTab("upload"));
$("assetTabLibrary").addEventListener("click", () => switchAssetTab("library"));
$("assetPickBtn").addEventListener("click", () => assetFileInput.click());
assetFileInput.addEventListener("change", (e) => {
  if (e.target.files?.length) handleIncomingFiles(e.target.files);
  assetFileInput.value = "";
});
assetDropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  assetDropzone.classList.add("dragover");
});
assetDropzone.addEventListener("dragleave", () => assetDropzone.classList.remove("dragover"));
assetDropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  assetDropzone.classList.remove("dragover");
  if (e.dataTransfer?.files?.length) handleIncomingFiles(e.dataTransfer.files);
});

// =====================================================================
// Video trim editor — non-destructive: trimming only stores a {start,end}
// window on the asset, so it's always revertable and the source clip is kept.
// =====================================================================
const trimModal = $("trimModal");
const trimVideo = $("trimVideo");
const trimTrack = $("trimTrack");
const trimRangeEl = $("trimRange");
const trimPlayhead = $("trimPlayhead");
const trimStartHandle = $("trimStartHandle");
const trimEndHandle = $("trimEndHandle");
let trimAsset = null;
let trimDur = 0;
let trimStart = 0;
let trimEnd = 0;
let trimResolving = false; // true while seeking to resolve an Infinity duration

function fmtTime(s) {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function updateTrimUI() {
  const pct = (t) => (trimDur > 0 ? (t / trimDur) * 100 : 0);
  trimStartHandle.style.left = pct(trimStart) + "%";
  trimEndHandle.style.left = pct(trimEnd) + "%";
  trimRangeEl.style.left = pct(trimStart) + "%";
  trimRangeEl.style.width = pct(trimEnd - trimStart) + "%";
  $("trimStartLabel").textContent = fmtTime(trimStart);
  $("trimEndLabel").textContent = fmtTime(trimEnd);
}

function updateTrimPlayhead() {
  const pct = trimDur > 0 ? (trimVideo.currentTime / trimDur) * 100 : 0;
  trimPlayhead.style.left = pct + "%";
}

function openTrimEditor(asset) {
  trimAsset = asset;
  trimModal.hidden = false;
  trimVideo.src = asset.url;

  const finishOpen = () => {
    trimStart = asset.trim?.start ?? 0;
    trimEnd = asset.trim?.end ?? trimDur;
    updateTrimUI();
    trimVideo.currentTime = trimStart;
    trimVideo.play().catch(() => {});
  };

  trimVideo.onloadedmetadata = () => {
    trimDur = trimVideo.duration;
    if (!isFinite(trimDur) || trimDur === 0) {
      // Some containers (notably MediaRecorder WebM) report Infinity until the
      // playhead is seeked past the end — do that once to resolve a real length.
      trimResolving = true;
      const fix = () => {
        trimVideo.removeEventListener("timeupdate", fix);
        trimDur = isFinite(trimVideo.duration) ? trimVideo.duration : (trimVideo.currentTime || 0);
        trimResolving = false;
        trimVideo.currentTime = 0;
        finishOpen();
      };
      trimVideo.addEventListener("timeupdate", fix);
      trimVideo.currentTime = 1e7;
      return;
    }
    finishOpen();
  };
}

function closeTrimEditor() {
  trimModal.hidden = true;
  try { trimVideo.pause(); } catch {}
  trimVideo.removeAttribute("src");
  trimVideo.load();
  trimAsset = null;
}

// Loop the preview within the selected range so the user sees the trimmed clip.
trimVideo.addEventListener("timeupdate", () => {
  if (trimModal.hidden || trimResolving) return;
  if (trimVideo.currentTime >= trimEnd || trimVideo.currentTime < trimStart - 0.05) {
    trimVideo.currentTime = trimStart;
  }
  updateTrimPlayhead();
});

// Drag the start/end handles along the track.
let trimDrag = null;
function trimPointerMove(e) {
  if (!trimDrag) return;
  const rect = trimTrack.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const t = frac * trimDur;
  if (trimDrag === "start") {
    trimStart = Math.min(t, trimEnd - 0.1);
    if (trimStart < 0) trimStart = 0;
    trimVideo.currentTime = trimStart;
  } else {
    trimEnd = Math.max(t, trimStart + 0.1);
    if (trimEnd > trimDur) trimEnd = trimDur;
  }
  updateTrimUI();
  updateTrimPlayhead();
}
function trimPointerUp() {
  trimDrag = null;
  window.removeEventListener("pointermove", trimPointerMove);
  window.removeEventListener("pointerup", trimPointerUp);
}
[trimStartHandle, trimEndHandle].forEach((h) => {
  h.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    trimDrag = h.dataset.h;
    window.addEventListener("pointermove", trimPointerMove);
    window.addEventListener("pointerup", trimPointerUp);
  });
});

// Re-seek any device currently playing this asset so it lands inside the new range.
function reseekDevicesForAsset(asset) {
  for (const d of devices) {
    if (d.screenVideoAsset === asset && d.screenVideo) {
      const start = asset.trim?.start ?? 0;
      if (d.screenVideo.currentTime < start) d.screenVideo.currentTime = start;
    }
  }
}

$("trimApply").addEventListener("click", () => {
  if (!trimAsset) return;
  const isFull = trimStart <= 0.01 && trimEnd >= trimDur - 0.01;
  trimAsset.trim = isFull ? null : { start: trimStart, end: trimEnd };
  reseekDevicesForAsset(trimAsset);
  renderAssets();
  setStatus(isFull ? "Trim cleared (full clip)." : `Trimmed to ${fmtTime(trimStart)}–${fmtTime(trimEnd)}.`);
  closeTrimEditor();
});

$("trimRevert").addEventListener("click", () => {
  if (!trimAsset) return;
  trimStart = 0;
  trimEnd = trimDur;
  trimAsset.trim = null;
  reseekDevicesForAsset(trimAsset);
  renderAssets();
  trimVideo.currentTime = 0;
  updateTrimUI();
  setStatus("Trim reverted to full clip.");
});

$("trimRemove").addEventListener("click", () => {
  if (!trimAsset) return;
  const asset = trimAsset;
  // Reset the screen on every device that was showing this clip.
  for (const d of devices) {
    if (d.screenVideoAsset === asset) {
      stopDeviceVideo(d);
      if (d.defaultScreenMaps) {
        configureEmissiveScreen(d.screenMaterial, d.defaultScreenMaps.emissiveMap || d.defaultScreenMaps.map);
      }
      d.uploadedTexture = null;
      d.screenBlob = null;
    }
  }
  const i = assets.indexOf(asset);
  if (i >= 0) assets.splice(i, 1);
  URL.revokeObjectURL(asset.url);
  renderAssets();
  updateSaveButtonLabel();
  closeTrimEditor();
  setStatus("Video removed.");
  render();
});

$("trimCancel").addEventListener("click", closeTrimEditor);

function applyDeviceBrightness(dev, value) {
  dev.settings.brightness = value;
  applyScreenLook(dev);
}

function applyScreenWarmth(dev, value) {
  dev.settings.warmth = value;
  applyScreenLook(dev);
}

// Drive the screen's emissive look from its brightness + warmth settings. The
// screen is a MeshBasicMaterial (toneMapped:false), so it renders map × color
// directly: scaling color past 1 over-drives the panel to read as self-lit, and
// tinting the channels shifts its white balance without touching the texture.
function applyScreenLook(dev) {
  if (!dev.screenMaterial) return;
  const b = dev.settings.brightness ?? 1;
  const w = dev.settings.warmth ?? 0; // -1 cool (blue) … +1 warm (amber)
  // Warmth pushes red up / blue down (or vice-versa) by up to 25%, green steady.
  const r = b * (1 + 0.25 * w);
  const g = b;
  const bl = b * (1 - 0.25 * w);
  dev.screenMaterial.color.setRGB(r, g, bl);
  dev.screenMaterial.needsUpdate = true;
}

// =====================================================================
// Phone color
// =====================================================================
const COLOR_PRESETS = [
  { name: "Silver", hex: "#c9ccce" },
  { name: "Deep Blue", hex: "#2e4257" },
  { name: "Cosmic Orange", hex: "#c8623a" },
  { name: "Black", hex: "#2b2b2e" },
  { name: "Natural", hex: "#9a948b" },
];
const bodyColorInput = $("bodyColor");
const swatchesEl = $("swatches");

function applyDeviceColor(dev, hex) {
  dev.settings.color = hex;
  const c = new THREE.Color(hex);
  const lighter = c.clone().lerp(new THREE.Color(0xffffff), 0.15);
  for (const m of dev.bodyMaterials.frame) m.color.copy(c);
  for (const m of dev.bodyMaterials.back) m.color.copy(c);
  for (const m of dev.bodyMaterials.antenna) m.color.copy(lighter);
}

function applyDeviceFinish(dev, r) {
  dev.settings.finish = r;
  for (const key of ["frame", "antenna", "back"]) {
    for (const m of dev.bodyMaterials[key]) m.roughness = r;
  }
}

function updateActiveSwatch(hex) {
  [...swatchesEl.children].forEach((s) =>
    s.classList.toggle("active", s.dataset.hex.toLowerCase() === hex.toLowerCase())
  );
}

function setBodyColor(hex) {
  bodyColorInput.value = hex;
  updateActiveSwatch(hex);
  if (activeDevice) applyDeviceColor(activeDevice, hex);
  render();
}

function setupSwatches() {
  swatchesEl.innerHTML = "";
  for (const p of COLOR_PRESETS) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = p.hex;
    b.dataset.hex = p.hex;
    b.title = p.name;
    b.addEventListener("click", () => setBodyColor(p.hex));
    swatchesEl.appendChild(b);
  }
}
setupSwatches();
bodyColorInput.addEventListener("input", () => setBodyColor(bodyColorInput.value));

// Scene-wide lighting contrast. The UI control was removed, so this just
// applies the default drama level on load.
function setDrama(v) {
  const t = THREE.MathUtils.clamp(parseFloat(v), 0, MAX_DRAMA);
  if (Number.isNaN(t)) return;
  applyDrama(t);
}
applyDrama(DEFAULT_DRAMA);

// Finish slider (per-device surface roughness). 0 = glossy, 1 = matte.
// Applies to the active device only; range + number stay in sync.
const finishInput = $("finish");
const finishNumber = $("finishN");
function setFinish(v) {
  const r = THREE.MathUtils.clamp(parseFloat(v), 0, 1);
  if (Number.isNaN(r)) return;
  finishInput.value = r;
  finishNumber.value = r;
  if (activeDevice) applyDeviceFinish(activeDevice, r);
  render();
}
finishInput.addEventListener("input", () => setFinish(finishInput.value));
finishNumber.addEventListener("input", () => setFinish(finishNumber.value));

// Screen brightness (emissivity) — per-device. The UI control was removed;
// kept so preset/device loads can still apply a stored value.
function setScreenBright(v) {
  const b = THREE.MathUtils.clamp(parseFloat(v), 0, 2);
  if (Number.isNaN(b)) return;
  if (activeDevice) applyDeviceBrightness(activeDevice, b);
  render();
}

// Screen warmth (white balance) — per-device. -1 cool/blue … +1 warm/amber.
function setScreenWarmth(v) {
  const w = THREE.MathUtils.clamp(parseFloat(v), -1, 1);
  if (Number.isNaN(w)) return;
  if (activeDevice) applyScreenWarmth(activeDevice, w);
  render();
}

// =====================================================================
// Transform: per-axis X/Y/Z for Move / Rotate / Scale
// =====================================================================
const sliders = [$("tX"), $("tY"), $("tZ")];
const nums = [$("tXn"), $("tYn"), $("tZn")];
const AXES = ["x", "y", "z"];
const RANGES = {
  translate: { min: -0.4, max: 0.4, step: 0.005 },
  rotate: { min: -180, max: 180, step: 1 },
};
// The background plane gets a wider X/Y pan range, and a dedicated Z (zoom) range
// that stops short of the camera (z≈0.6) so it can't be pushed out of view.
const BG_RANGES = {
  translate: { min: -1.5, max: 1.5, step: 0.01 },
  rotate: { min: -180, max: 180, step: 1 },
};
const BG_Z_RANGE = { min: -3, max: 0.45, step: 0.01 }; // pull back = zoom out, push in = zoom in

// The group the gizmo / sliders currently drive (a device or the background).
function transformTarget() {
  return activeKind === "background" ? bgLayer.group : (activeDevice && activeDevice.group);
}
function currentRanges() {
  return (activeKind === "background" ? BG_RANGES : RANGES)[mode];
}
// Per-axis range. The background's Z axis is the zoom control with its own range.
function axisRange(i) {
  if (activeKind === "background" && mode === "translate" && i === 2) return BG_Z_RANGE;
  return currentRanges();
}

// Format a value for the number box: integer degrees, or 3-dp metres.
function fmtAxis(v) {
  return mode === "rotate" ? String(Math.round(v)) : String(Math.round(v * 1000) / 1000);
}
// Current value of axis i (position in metres, or rotation in degrees).
function readAxis(i) {
  const g = transformTarget();
  return mode === "translate"
    ? g.position[AXES[i]]
    : THREE.MathUtils.radToDeg(g.rotation[AXES[i]]);
}
// Apply a value to axis i (clamped to the active mode's range). Returns clamped value.
function writeAxis(i, value) {
  const r = axisRange(i);
  const v = Math.min(r.max, Math.max(r.min, value));
  const g = transformTarget();
  if (mode === "translate") g.position[AXES[i]] = v;
  else g.rotation[AXES[i]] = THREE.MathUtils.degToRad(v);
  return v;
}

function refreshTransformSliders() {
  if (!transformTarget()) return;
  for (let i = 0; i < 3; i++) {
    const r = axisRange(i);
    for (const el of [sliders[i], nums[i]]) {
      el.min = r.min;
      el.max = r.max;
      el.step = r.step;
    }
    const v = readAxis(i);
    sliders[i].value = v;
    nums[i].value = fmtAxis(v);
  }
}

// Sliders drive the value and mirror it into the number box.
sliders.forEach((el, i) =>
  el.addEventListener("input", () => {
    if (!activeDevice) return;
    nums[i].value = fmtAxis(writeAxis(i, parseFloat(el.value)));
    render();
  })
);
// Number boxes accept typed values, mirrored into the slider.
nums.forEach((el, i) => {
  el.addEventListener("input", () => {
    if (!activeDevice) return;
    const raw = parseFloat(el.value);
    if (Number.isNaN(raw)) return; // mid-typing (e.g. "-" or "")
    sliders[i].value = writeAxis(i, raw);
    render();
  });
  el.addEventListener("change", () => {
    if (!activeDevice) return;
    const raw = parseFloat(el.value);
    const v = writeAxis(i, Number.isNaN(raw) ? readAxis(i) : raw);
    sliders[i].value = v;
    nums[i].value = fmtAxis(v); // normalise / clamp on commit
    render();
  });
});

const modeButtons = [...document.querySelectorAll(".mode")];
function setMode(m) {
  mode = m;
  transform.setMode(m);
  transform.setSpace(m === "rotate" ? "local" : "world");
  modeButtons.forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  $("resetXform").textContent = m === "rotate" ? "↻ Reset rotate" : "↻ Reset move";
  refreshTransformSliders();
  render();
}
modeButtons.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

$("gizmoToggle").addEventListener("change", (e) => {
  transform.enabled = e.target.checked;
  transform.visible = e.target.checked;
  render();
});

// Reset only the active tab (Move resets position, Rotate resets rotation).
$("resetXform").addEventListener("click", () => {
  const g = transformTarget();
  if (!g) return;
  if (activeKind === "background") {
    if (mode === "translate") g.position.set(0, 0, BG_HOME_Z);
    else g.rotation.set(0, 0, 0);
  } else if (mode === "translate") {
    const i = devices.indexOf(activeDevice);
    g.position.set(i * DEVICE_SPACING, 0, 0);
  } else {
    g.rotation.set(0, 0, 0);
  }
  refreshTransformSliders();
  render();
});

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "w") setMode("translate");
  if (e.key === "e") setMode("rotate");
});

// Scene: background is always transparent. The key/fill/env levels are set
// together from the Drama control.
applyDrama(DEFAULT_DRAMA);

// =====================================================================
// Project title — click to edit; falls back to "Untitled" when cleared.
// =====================================================================
const projectTitle = $("projectTitle");
projectTitle.addEventListener("focus", () => projectTitle.select());
projectTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") projectTitle.blur();
});
projectTitle.addEventListener("blur", () => {
  const name = projectTitle.value.trim();
  projectTitle.value = name || "Untitled";
});

// =====================================================================
// Menu tabs — switch the panel between Editor controls and saved Mockups.
// =====================================================================
const editorPanel = $("editorPanel");
const mockupsPanel = $("mockupsPanel");
function switchPanelTab(tab) {
  const isMockups = tab === "mockups";
  editorPanel.hidden = isMockups;
  mockupsPanel.hidden = !isMockups;
  $("tabEditor").classList.toggle("active", !isMockups);
  $("tabMockups").classList.toggle("active", isMockups);
  if (isMockups && currentUser) refreshMockups();
}
$("tabEditor").addEventListener("click", () => switchPanelTab("editor"));
$("tabMockups").addEventListener("click", () => switchPanelTab("mockups"));

// =====================================================================
// Save → crop modal
// =====================================================================
const saveModal = $("saveModal");
const cropImg = $("cropImg");
const cropBox = $("cropBox");
const cropStage = $("cropStage");

// Target long edge of the exported image/video, in pixels. The 4K standard.
const EXPORT_LONG_EDGE = 3840;

// The crop-modal preview is rendered with its long edge at this resolution, NOT
// 4K. We oversample well past 4K so that the cropped sub-region — taken straight
// from the preview image's pixels, never re-rendered — still lands at ~4K for a
// normal crop (a 50% crop keeps 4096px; a 70% crop ~5700px). Cropping the actual
// preview pixels is what guarantees the saved image is framed EXACTLY like the
// crop box: re-rendering at download time drifts, because the canvas/camera
// state changes once the modal is open.
const PREVIEW_LONG_EDGE = 8192;

// Largest pixel-ratio the GPU can back for the current viewport without blowing
// past its max texture size. Caps the preview render.
function maxExportScaleFactor() {
  const longEdgeCss = Math.max(canvas.clientWidth, canvas.clientHeight);
  const maxBuf = renderer.capabilities.maxTextureSize || 8192;
  return maxBuf / longEdgeCss;
}

// Pixel-ratio that makes the preview's long edge equal PREVIEW_LONG_EDGE,
// clamped to what the GPU can allocate.
function exportScaleFactor() {
  const longEdgeCss = Math.max(canvas.clientWidth, canvas.clientHeight);
  return Math.min(PREVIEW_LONG_EDGE / longEdgeCss, maxExportScaleFactor());
}

// The camera aspect + canvas size used for the most recent preview render. The
// video export reuses this so its frames are composed identically to the still
// preview the user cropped against (the live canvas can differ once the modal is
// open).
let previewBasis = null;

function renderToBlob(scaleFactor = exportScaleFactor()) {
  const prevRatio = renderer.getPixelRatio();
  const gizmoWasVisible = transform.visible;
  transform.visible = false;
  previewBasis = { camAspect: camera.aspect, w: canvas.clientWidth, h: canvas.clientHeight };
  renderer.setPixelRatio(scaleFactor);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderFrame(); // background pass + devices; transparent where nothing is drawn
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      transform.visible = gizmoWasVisible;
      renderer.setPixelRatio(prevRatio);
      onResize();
      resolve(blob);
    }, "image/png");
  });
}

// Swap the Save button (and the crop modal's download button) between still and
// video output depending on whether any device's screen is a clip.
function updateSaveButtonLabel() {
  const vid = isVideoMockup();
  $("savePng").textContent = vid ? "⤓ Save as video" : "⤓ Save as PNG";
  $("cropDownload").textContent = vid ? "⤓ Download video" : "⤓ Download PNG";
}

$("savePng").addEventListener("click", async () => {
  setStatus("Rendering…");
  updateSaveButtonLabel();
  const blob = await renderToBlob();
  cropImg.src = URL.createObjectURL(blob);
  cropImg.onload = () => {
    saveModal.hidden = false;
    // Wait for the image to decode and the modal layout to settle so the crop
    // box matches the displayed size and the pixels are readable.
    const fit = () => requestAnimationFrame(() => requestAnimationFrame(autoFitCropBox));
    if (cropImg.decode) cropImg.decode().then(fit, fit);
    else fit();
  };
  setStatus("Crop and download your mockup.");
});

$("cropCancel").addEventListener("click", () => {
  saveModal.hidden = true;
  if (cropImg.src) URL.revokeObjectURL(cropImg.src);
});
$("cropReset").addEventListener("click", autoFitCropBox);

function setCropRect(left, top, width, height) {
  cropBox.style.left = left + "px";
  cropBox.style.top = top + "px";
  cropBox.style.width = width + "px";
  cropBox.style.height = height + "px";
}

function fullCropBox() {
  setCropRect(0, 0, cropImg.clientWidth, cropImg.clientHeight);
}

// Default crop: snap to the rendered content (non-transparent pixels) with a
// slight even gap on each side. The background is transparent, so we find the
// alpha bounding box. Falls back to the full image if detection fails.
function autoFitCropBox() {
  try {
    autoFitCropBoxImpl();
  } catch {
    fullCropBox();
  }
}

function autoFitCropBoxImpl() {
  const nW = cropImg.naturalWidth;
  const nH = cropImg.naturalHeight;
  const dW = cropImg.clientWidth;
  const dH = cropImg.clientHeight;
  if (!nW || !nH || !dW || !dH) return fullCropBox();

  // Analyse at reduced resolution for speed.
  const aw = Math.min(nW, 500);
  const scale = aw / nW;
  const ah = Math.max(1, Math.round(nH * scale));
  const cv = document.createElement("canvas");
  cv.width = aw;
  cv.height = ah;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(cropImg, 0, 0, aw, ah);
  let data;
  try {
    data = cx.getImageData(0, 0, aw, ah).data;
  } catch {
    return fullCropBox();
  }

  let minX = aw, minY = ah, maxX = -1, maxY = -1;
  const ALPHA = 20;
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      if (data[(y * aw + x) * 4 + 3] > ALPHA) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return fullCropBox(); // nothing found

  // Content box in displayed pixels.
  const sx = dW / aw;
  const sy = dH / ah;
  let bx = minX * sx;
  let by = minY * sy;
  let bw = (maxX - minX + 1) * sx;
  let bh = (maxY - minY + 1) * sy;

  // Even gap on each side (~1.67% of the content's larger side, min 3px).
  const pad = Math.max(3, Math.round(0.0167 * Math.max(bw, bh)));
  let left = Math.max(0, bx - pad);
  let top = Math.max(0, by - pad);
  let right = Math.min(dW, bx + bw + pad);
  let bottom = Math.min(dH, by + bh + pad);
  setCropRect(left, top, right - left, bottom - top);
}

// Drag to move / resize the crop box (mouse + touch via pointer events).
let dragState = null;
function px(v) {
  return parseFloat(v) || 0;
}
function startDrag(e, handle) {
  e.preventDefault();
  dragState = {
    handle,
    startX: e.clientX,
    startY: e.clientY,
    left: px(cropBox.style.left),
    top: px(cropBox.style.top),
    width: cropBox.offsetWidth,
    height: cropBox.offsetHeight,
  };
  window.addEventListener("pointermove", onDrag);
  window.addEventListener("pointerup", endDrag);
}
function onDrag(e) {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  const maxW = cropImg.clientWidth;
  const maxH = cropImg.clientHeight;
  let { left, top, width, height } = dragState;
  const min = 20;
  if (!dragState.handle) {
    left = Math.min(Math.max(0, left + dx), maxW - width);
    top = Math.min(Math.max(0, top + dy), maxH - height);
  } else {
    const h = dragState.handle;
    if (h.includes("l")) {
      const nl = Math.min(Math.max(0, left + dx), left + width - min);
      width += left - nl;
      left = nl;
    }
    if (h.includes("r")) {
      width = Math.min(Math.max(min, width + dx), maxW - left);
    }
    if (h.includes("t")) {
      const nt = Math.min(Math.max(0, top + dy), top + height - min);
      height += top - nt;
      top = nt;
    }
    if (h.includes("b")) {
      height = Math.min(Math.max(min, height + dy), maxH - top);
    }
  }
  cropBox.style.left = left + "px";
  cropBox.style.top = top + "px";
  cropBox.style.width = width + "px";
  cropBox.style.height = height + "px";
}
function endDrag() {
  dragState = null;
  window.removeEventListener("pointermove", onDrag);
  window.removeEventListener("pointerup", endDrag);
}
cropBox.addEventListener("pointerdown", (e) => {
  if (e.target.classList.contains("handle")) startDrag(e, e.target.dataset.h);
  else startDrag(e, null);
});

// Crop rect normalized to [0,1] over the previewed image. The same fractions map
// onto the still-image crop and the video export.
function cropRectNormalized() {
  return {
    x: px(cropBox.style.left) / cropImg.clientWidth,
    y: px(cropBox.style.top) / cropImg.clientHeight,
    w: cropBox.offsetWidth / cropImg.clientWidth,
    h: cropBox.offsetHeight / cropImg.clientHeight,
  };
}

// Crop straight out of the high-res preview image's pixels. No re-render, so the
// saved PNG is framed pixel-for-pixel like the crop box. Because the preview is
// rendered at PREVIEW_LONG_EDGE (8K-class), a normal crop still yields ~4K.
function downloadStillPng() {
  const ratio = cropImg.naturalWidth / cropImg.clientWidth;
  const sx = px(cropBox.style.left) * ratio;
  const sy = px(cropBox.style.top) * ratio;
  const sw = cropBox.offsetWidth * ratio;
  const sh = cropBox.offsetHeight * ratio;
  const out = document.createElement("canvas");
  out.width = Math.round(sw);
  out.height = Math.round(sh);
  out.getContext("2d").drawImage(cropImg, sx, sy, sw, sh, 0, 0, out.width, out.height);
  out.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `iphone-mockup-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    saveModal.hidden = true;
    setStatus(`Saved PNG (${out.width}×${out.height}).`);
  }, "image/png");
}

// Pick a MediaRecorder mime that preserves alpha. WebM VP9/VP8 carry an alpha
// channel in Chromium, so the exported clip keeps the transparent background.
function pickVideoMime() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

// Record the cropped, transparent scene to a WebM clip for the duration of the
// longest device clip's trim window. Each frame: render the scene, then blit the
// crop region into a 2D canvas whose captureStream() feeds the recorder.
async function downloadVideo(cropNorm) {
  const mime = pickVideoMime();
  if (!mime) {
    setStatus("Video export isn't supported in this browser.");
    return;
  }
  const vids = devices
    .filter((d) => d.screenIsVideo && d.screenVideo)
    .map((d) => ({ v: d.screenVideo, asset: d.screenVideoAsset }));
  if (!vids.length) return downloadStillPng();

  const durOf = (x) => (x.asset?.trim?.end ?? x.v.duration) - (x.asset?.trim?.start ?? 0);
  const maxDur = Math.max(...vids.map(durOf));

  // Reproduce the still preview's exact framing: same camera aspect and the same
  // canvas proportions used when the preview was rendered (previewBasis), so the
  // recorded frames line up with the crop box. Then size the full frame so the
  // cropped output's long edge is true 4K, clamped to the GPU's texture limit.
  const basis = previewBasis || { camAspect: camera.aspect, w: canvas.clientWidth, h: canvas.clientHeight };
  const aspect = basis.w / basis.h;
  const maxTex = renderer.capabilities.maxTextureSize || 8192;
  let fullW = EXPORT_LONG_EDGE / Math.max(cropNorm.w, cropNorm.h / aspect);
  let fullH = fullW / aspect;
  const k = Math.min(1, maxTex / fullW, maxTex / fullH);
  fullW = Math.round(fullW * k);
  fullH = Math.round(fullH * k);
  const outW = Math.max(2, Math.round(cropNorm.w * fullW));
  const outH = Math.max(2, Math.round(cropNorm.h * fullH));
  const sx = cropNorm.x * fullW;
  const sy = cropNorm.y * fullH;

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d");

  // Bitrate scales with resolution (~0.2 bits/px/frame at 30fps), capped at
  // 60 Mbps so a 4K clip stays high-quality without ballooning the file.
  const bitrate = Math.min(60_000_000, Math.round(outW * outH * 30 * 0.2));
  const stream = out.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  // Take over rendering: full-res, no gizmo, and pause the on-demand loop.
  exporting = true;
  const prevRatio = renderer.getPixelRatio();
  const prevAspect = camera.aspect;
  const gizmoWasVisible = transform.visible;
  transform.visible = false;
  renderer.setPixelRatio(1);
  renderer.setSize(fullW, fullH, false);
  camera.aspect = basis.camAspect;
  camera.updateProjectionMatrix();

  // Restart every clip at its trim start so they're in sync.
  for (const x of vids) {
    x.v.currentTime = x.asset?.trim?.start ?? 0;
    try { await x.v.play(); } catch {}
  }

  setStatus("Recording video…");
  rec.start();
  const startT = performance.now();

  await new Promise((resolve) => {
    function frame() {
      renderFrame();
      octx.clearRect(0, 0, outW, outH);
      // The background plane is in the render, so just blit the crop region.
      octx.drawImage(canvas, sx, sy, outW, outH, 0, 0, outW, outH);
      const elapsed = (performance.now() - startT) / 1000;
      if (elapsed >= maxDur) return resolve();
      requestAnimationFrame(frame);
    }
    frame();
  });

  rec.stop();
  await new Promise((r) => (rec.onstop = r));

  // Restore the interactive renderer state.
  transform.visible = gizmoWasVisible;
  renderer.setPixelRatio(prevRatio);
  camera.aspect = prevAspect;
  camera.updateProjectionMatrix();
  exporting = false;
  onResize();

  const blob = new Blob(chunks, { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `iphone-mockup-${Date.now()}.webm`;
  a.click();
  URL.revokeObjectURL(a.href);
  saveModal.hidden = true;
  setStatus("Saved video (WebM, transparent background).");
}

$("cropDownload").addEventListener("click", () => {
  if (isVideoMockup()) downloadVideo(cropRectNormalized());
  else downloadStillPng();
});

// =====================================================================
// Render loop
// =====================================================================
function render() {
  needsRender = true;
}
controls.addEventListener("change", render);

// Draw one frame: background scene first (if active), then clear the depth buffer
// so it never occludes the devices, then the main scene on top. Used everywhere
// we render — the live loop, the snapshot, and the video export.
renderer.autoClear = false;
function renderFrame() {
  renderer.clear();
  if (bgLayer.active && bgLayer.group && bgLayer.group.visible) {
    renderer.render(bgScene, camera);
  }
  renderer.clearDepth();
  renderer.render(scene, camera);
}

// True while downloadVideo() owns the renderer, so the on-demand loop stands down.
let exporting = false;

// A playing device clip means the scene is animating, so keep drawing every frame
// (VideoTexture refreshes itself via requestVideoFrameCallback).
function anyVideoPlaying() {
  return devices.some((d) => d.screenVideo && !d.screenVideo.paused && !d.screenVideo.ended);
}

function animate() {
  requestAnimationFrame(animate);
  if (exporting) return; // downloadVideo drives rendering itself
  controls.update();
  if (anyVideoPlaying()) needsRender = true;
  if (needsRender) {
    renderFrame();
    needsRender = false;
  }
}
animate();

function onResize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (bgLayer.active) fitBgPlane(); // keep the plane covering the new aspect
  render();
}
window.addEventListener("resize", onResize);
onResize();

// =====================================================================
// Presets — capture every device's transform + the camera view.
// Presets are shared: hardcoded base defaults live in presets.js and any saved
// presets live in the Supabase `shared_presets` table, so "Save preset" makes a
// preset everyone gets. (The screen image is never part of a preset.)
// =====================================================================
const presetSelect = $("presetSelect");
let sharedPresets = []; // loaded from Supabase: { id, name, camera, devices }

// Combined list: hardcoded base defaults first, then shared (DB) presets.
function allPresets() {
  return [
    ...DEFAULT_PRESETS.map((p) => ({ preset: p, id: null })),
    ...sharedPresets.map((p) => ({ preset: p, id: p.id })),
  ];
}

function renderPresetSelect() {
  presetSelect.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "Apply a preset…";
  presetSelect.appendChild(ph);
  allPresets().forEach((entry, idx) => {
    const o = document.createElement("option");
    o.value = String(idx);
    o.textContent = entry.preset.name;
    presetSelect.appendChild(o);
  });
}

async function loadSharedPresets() {
  const { data, error } = await supabase
    .from("shared_presets")
    .select("*")
    .order("created_at");
  if (error) return; // table may not exist yet — fall back to hardcoded defaults
  sharedPresets = (data || []).map((r) => ({ id: r.id, name: r.name, ...r.data }));
  renderPresetSelect();
}

function capturePreset() {
  const r4 = (n) => Math.round(n * 10000) / 10000;
  // Camera view is intentionally NOT captured — the camera stays consistent
  // across all presets, so presets only describe device transforms.
  return {
    devices: devices.map((d) => ({
      type: d.type.id,
      pos: d.group.position.toArray().map(r4),
      rot: [d.group.rotation.x, d.group.rotation.y, d.group.rotation.z].map(r4),
      scale: d.group.scale.toArray().map(r4),
    })),
  };
}

async function applyPreset(p) {
  if (!p || !p.devices?.length) return;
  // Carry the current screen images over by index so a test image survives.
  const blobs = devices.map((d) => d.screenBlob);
  for (const d of [...devices]) { stopDeviceVideo(d); scene.remove(d.group); }
  devices.length = 0;
  deviceTypeCounts.clear();

  for (let i = 0; i < p.devices.length; i++) {
    const pd = p.devices[i];
    const typeId = pd.type || "iphone17pro";
    const type = DEVICE_TYPES.find((t) => t.id === typeId) || DEVICE_TYPES[0];
    const tmpl = await loadTemplate(type);
    const dev = buildDevice(type, tmpl);
    if (pd.pos) dev.group.position.fromArray(pd.pos);
    if (pd.rot) dev.group.rotation.set(pd.rot[0], pd.rot[1], pd.rot[2]);
    if (pd.scale) dev.group.scale.fromArray(pd.scale);
    if (blobs[i]) applyScreenBlobToDevice(dev, blobs[i]);
  }

  // Camera is left untouched so framing stays consistent across presets.
  selectDevice(devices[0]);
  renderDeviceBar();
  updateSaveButtonLabel();
  render();
}

presetSelect.addEventListener("change", () => {
  const v = presetSelect.value;
  presetSelect.value = ""; // reset so the same preset can be re-applied
  if (v === "") return;
  const entry = allPresets()[parseInt(v, 10)];
  if (entry) {
    applyPreset(entry.preset);
    setStatus(`Applied preset “${entry.preset.name}”.`);
  }
});

$("savePreset").addEventListener("click", async () => {
  const name = prompt("Preset name:", "My preset");
  if (!name) return;
  setStatus("Saving preset…");
  const data = capturePreset();
  const { data: row, error } = await supabase
    .from("shared_presets")
    .insert({ name, data })
    .select()
    .single();
  if (error) {
    return setStatus("Save failed: " + error.message + " (did you run supabase/presets.sql?)");
  }
  sharedPresets.push({ id: row.id, name: row.name, ...row.data });
  renderPresetSelect();
  // Surface the new preset immediately: show it selected in the dropdown.
  const newIdx = allPresets().findIndex((e) => e.id === row.id);
  if (newIdx >= 0) presetSelect.value = String(newIdx);
  setStatus(`Saved preset “${name}” — everyone gets it now.`);
});

$("deletePreset").addEventListener("click", async () => {
  const v = presetSelect.value;
  if (v === "") return setStatus("Pick a preset to delete.");
  const entry = allPresets()[parseInt(v, 10)];
  if (!entry?.id) return setStatus("Built-in presets can't be deleted.");
  const { error } = await supabase.from("shared_presets").delete().eq("id", entry.id);
  if (error) return setStatus("Delete failed: " + error.message);
  sharedPresets = sharedPresets.filter((p) => p.id !== entry.id);
  renderPresetSelect();
  setStatus("Preset deleted.");
});

renderPresetSelect();
loadSharedPresets();

// =====================================================================
// Account (Supabase auth) + cloud-saved mockups (multi-device)
// =====================================================================
function getSceneState() {
  return {
    drama, // scene-wide lighting contrast
    devices: devices.map((d) => ({
      type: d.type.id,
      settings: { ...d.settings },
      pos: d.group.position.toArray(),
      rot: [d.group.rotation.x, d.group.rotation.y, d.group.rotation.z],
      scale: d.group.scale.toArray(),
    })),
  };
}

async function applySceneState(state, imagePaths) {
  if (!state) return;
  setDrama(state.drama ?? DEFAULT_DRAMA); // restore lighting (default for old saves)
  // Clear existing devices.
  for (const d of [...devices]) { stopDeviceVideo(d); scene.remove(d.group); }
  devices.length = 0;
  deviceTypeCounts.clear();

  for (let i = 0; i < (state.devices?.length || 0); i++) {
    const ds = state.devices[i];
    const typeId = ds.type || "iphone17pro";
    const type = DEVICE_TYPES.find((t) => t.id === typeId) || DEVICE_TYPES[0];
    const tmpl = await loadTemplate(type);
    const dev = buildDevice(type, tmpl);
    applyDeviceColor(dev, ds.settings.color);
    applyDeviceFinish(dev, ds.settings.finish);
    applyScreenWarmth(dev, ds.settings.warmth ?? 0);
    applyDeviceBrightness(dev, ds.settings.brightness ?? 1);
    dev.settings.fit = ds.settings.fit || "cover";
    if (Array.isArray(ds.pos)) dev.group.position.fromArray(ds.pos);
    if (Array.isArray(ds.rot)) dev.group.rotation.set(ds.rot[0], ds.rot[1], ds.rot[2]);
    if (Array.isArray(ds.scale)) dev.group.scale.fromArray(ds.scale);
    const path = imagePaths?.[i];
    if (path) {
      const { data } = await supabase.storage.from("mockups").createSignedUrl(path, 3600);
      if (data?.signedUrl) {
        const blob = await (await fetch(data.signedUrl)).blob();
        applyScreenBlobToDevice(dev, blob);
      }
    }
  }
  selectDevice(devices[0]);
  renderDeviceBar();
  updateSaveButtonLabel();
}

const headerSignedOut = $("headerSignedOut");
const headerSignedIn = $("headerSignedIn");
const authModal = $("authModal");
const authEmail = $("authEmail");
const authPassword = $("authPassword");
const authNote = $("authNote");
const cloudGroup = $("cloudGroup");
const mockupList = $("mockupList");

function setAuthNote(msg, isError = false) {
  authNote.textContent = msg || "";
  authNote.classList.toggle("error", isError);
}

function openAuthModal() {
  setAuthNote("");
  authModal.hidden = false;
  authEmail.focus();
}
$("openLogin").addEventListener("click", openAuthModal);
$("openSignup").addEventListener("click", openAuthModal);
$("authClose").addEventListener("click", () => (authModal.hidden = true));

function updateAuthUI(session) {
  const user = session?.user;
  currentUser = user || null;
  headerSignedOut.hidden = !!user;
  headerSignedIn.hidden = !user;
  cloudGroup.hidden = !user;
  $("mockupsSignedOutNote").hidden = !!user;
  if (user) {
    $("userEmail").textContent = user.email;
    authModal.hidden = true; // close the modal once signed in
    refreshMockups();
    remoteAssetsLoaded = false;
    loadRemoteAssets();
  } else {
    mockupList.innerHTML = "";
    // Drop account-backed assets from the library on sign-out.
    for (let i = assets.length - 1; i >= 0; i--) {
      if (assets[i].remote) assets.splice(i, 1);
    }
    remoteAssetsLoaded = false;
    renderAssets();
  }
}

$("signIn").addEventListener("click", async () => {
  setAuthNote("Signing in…");
  const { error } = await supabase.auth.signInWithPassword({
    email: authEmail.value.trim(),
    password: authPassword.value,
  });
  setAuthNote(error ? error.message : "", !!error);
});
$("signUp").addEventListener("click", async () => {
  setAuthNote("Creating account…");
  const { data, error } = await supabase.auth.signUp({
    email: authEmail.value.trim(),
    password: authPassword.value,
  });
  if (error) return setAuthNote(error.message, true);
  setAuthNote(
    data.session
      ? "Account created — you're signed in."
      : "Account created. Check your email to confirm, then sign in."
  );
});
$("signOut").addEventListener("click", () => supabase.auth.signOut());
supabase.auth.onAuthStateChange((_e, session) => updateAuthUI(session));
supabase.auth.getSession().then(({ data }) => updateAuthUI(data.session));

$("saveCloud").addEventListener("click", async () => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return setStatus("Sign in to save mockups.");
  // Use the project title from the header instead of prompting for a name.
  const name = projectTitle.value.trim() || "Untitled";
  setStatus("Saving mockup…");

  // Upload each device's screen image (if any), collecting paths in order.
  const imagePaths = [];
  for (const d of devices) {
    if (d.screenBlob) {
      const path = `${user.id}/${crypto.randomUUID()}.png`;
      const { error: upErr } = await supabase.storage
        .from("mockups")
        .upload(path, d.screenBlob, { contentType: d.screenBlob.type || "image/png", upsert: true });
      if (upErr) return setStatus("Image upload failed: " + upErr.message);
      imagePaths.push(path);
    } else {
      imagePaths.push(null);
    }
  }

  const settings = { ...getSceneState(), imagePaths };
  const { error } = await supabase.from("mockups").insert({
    user_id: user.id,
    name: name || "Untitled",
    settings,
    image_path: imagePaths.find(Boolean) || null,
  });
  if (error) return setStatus("Save failed: " + error.message);
  setStatus(`Saved “${name || "Untitled"}”.`);
  refreshMockups();
});

async function refreshMockups() {
  const { data, error } = await supabase
    .from("mockups")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return setStatus("Could not load mockups: " + error.message);
  renderMockupList(data || []);
}

function renderMockupList(rows) {
  mockupList.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "authnote";
    empty.textContent = "No saved mockups yet.";
    mockupList.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "mockup-item";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.name;
    name.title = "Load this mockup";
    name.addEventListener("click", () => loadMockup(row));
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "🗑";
    del.title = "Delete";
    del.addEventListener("click", () => deleteMockup(row));
    item.append(name, del);
    mockupList.appendChild(item);
  }
}

async function loadMockup(row) {
  setStatus(`Loading “${row.name}”…`);
  const s = row.settings || {};
  await applySceneState(s, s.imagePaths);
  setStatus(`Loaded “${row.name}”.`);
}

async function deleteMockup(row) {
  if (!confirm(`Delete “${row.name}”?`)) return;
  const paths = (row.settings?.imagePaths || []).filter(Boolean);
  if (paths.length) await supabase.storage.from("mockups").remove(paths);
  const { error } = await supabase.from("mockups").delete().eq("id", row.id);
  if (error) return setStatus("Delete failed: " + error.message);
  setStatus(`Deleted “${row.name}”.`);
  refreshMockups();
}
