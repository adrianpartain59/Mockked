import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { supabase } from "./supabase.js";
import { DEFAULT_PRESETS } from "./presets.js";

const MODEL_URL = "iphone-17-pro/source/iPhone%2017%20Pro.glb";
const ENV_URL = "studio_small_08_4k.exr";

const SCREEN_ASPECT = 1206 / 2622; // iPhone 17 Pro display aspect (w/h)
const DEFAULT_COLOR = "#4a4a50"; // a lighter graphite-black
const DEFAULT_FINISH = 0.42;
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
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

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

// --- Lighting from EXR environment ---
const pmrem = new THREE.PMREMGenerator(renderer);
new EXRLoader().load(
  ENV_URL,
  (tex) => {
    const env = pmrem.fromEquirectangular(tex).texture;
    scene.environment = env;
    tex.dispose();
    pmrem.dispose();
    render();
  },
  undefined,
  () => setStatus("Could not load environment map (lighting reduced).")
);
const key = new THREE.DirectionalLight(0xffffff, 2);
key.position.set(1, 2, 2);
scene.add(key);
scene.add(new THREE.AmbientLight(0xffffff, 0.3));

// =====================================================================
// Devices
// =====================================================================
let templateModel = null;     // loaded GLB scene, cloned per device
let modelCenter = new THREE.Vector3();
let modelScale = 1;
const devices = [];
let activeDevice = null;
let deviceCounter = 0;
let mode = "translate";

new GLTFLoader().load(
  MODEL_URL,
  (gltf) => {
    templateModel = gltf.scene;
    const box = new THREE.Box3().setFromObject(templateModel);
    box.getCenter(modelCenter);
    const size = box.getSize(new THREE.Vector3());
    modelScale = 0.16 / Math.max(size.x, size.y, size.z);

    loadingEl.classList.add("hidden");
    addDevice(); // first device
    setStatus("Ready. Upload an image for the screen, or ＋ Add Device.");
    render();
  },
  (e) => {
    if (e.total) setStatus(`Loading model… ${Math.round((e.loaded / e.total) * 100)}%`);
  },
  () => {
    loadingEl.textContent = "Failed to load model.";
    setStatus("Failed to load the .glb model.");
  }
);

// Build one independent iPhone instance (cloned geometry, cloned materials).
function buildDevice() {
  const model = templateModel.clone(true);
  // Each name can appear on more than one mesh (cloning makes separate material
  // copies), so collect *all* instances or some surfaces won't get recoloured.
  const bodyMaterials = { frame: [], antenna: [], back: [] };
  let screenMaterial = null;
  let defaultScreenMaps = null;

  model.traverse((o) => {
    if (!o.isMesh) return;
    o.material = Array.isArray(o.material)
      ? o.material.map((m) => m.clone())
      : o.material.clone();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.name === "OLED") {
        screenMaterial = m;
        defaultScreenMaps = { map: m.map, emissiveMap: m.emissiveMap, color: m.color.clone() };
        m.toneMapped = false; // show the screen image at true pixel values
      }
      if (m.name === "Glass") {
        m.opacity = 0.08; // thin the near-black cover glass so the screen reads true
        m.needsUpdate = true;
      }
      if (m.name === "Anodized aluminum") bodyMaterials.frame.push(m);
      if (m.name === "Plastic antena") bodyMaterials.antenna.push(m);
      if (m.name === "Frosted glass") bodyMaterials.back.push(m);
    }
  });
  const allBody = [...bodyMaterials.frame, ...bodyMaterials.antenna, ...bodyMaterials.back];
  for (const m of allBody) {
    if (m.normalScale) m.normalScale.set(0.05, -0.05); // tame the sparkle
  }
  // The aluminium frame is the big "sparkly" surface. Its high metalness made it
  // mirror the studio HDRI (silver glitter) and hid the chosen colour, so drop
  // metalness to a satin level where the anodised colour actually reads, and
  // flatten its detailed normal map that was causing the glitter.
  for (const m of bodyMaterials.frame) {
    m.metalness = 0.3;
    if (m.normalScale) m.normalScale.set(0, 0);
  }

  // Center + scale + face the screen forward, inside a pivot so the outer group
  // transform (driven by gizmo / sliders) starts at identity.
  model.position.copy(modelCenter).negate();
  const pivot = new THREE.Group();
  pivot.scale.setScalar(modelScale);
  pivot.rotation.y = Math.PI;
  pivot.add(model);
  const group = new THREE.Group();
  group.add(pivot);
  scene.add(group);

  const dev = {
    id: ++deviceCounter,
    group,
    model,
    screenMaterial,
    bodyMaterials,
    defaultScreenMaps,
    screenBlob: null,
    uploadedTexture: null,
    uploadedImageSize: { w: 1, h: 1 },
    settings: { color: DEFAULT_COLOR, finish: DEFAULT_FINISH, fit: "cover", brightness: 1 },
  };
  devices.push(dev);
  applyDeviceColor(dev, dev.settings.color);
  applyDeviceFinish(dev, dev.settings.finish);
  applyDeviceBrightness(dev, dev.settings.brightness);
  return dev;
}

function addDevice() {
  const dev = buildDevice();
  dev.group.position.x = (devices.length - 1) * DEVICE_SPACING;
  selectDevice(dev);
  renderDeviceBar();
  render();
  setStatus(`Added device ${dev.id}.`);
}

function removeDevice(dev) {
  if (devices.length <= 1) return; // always keep at least one
  scene.remove(dev.group);
  const i = devices.indexOf(dev);
  devices.splice(i, 1);
  if (activeDevice === dev) selectDevice(devices[Math.max(0, i - 1)]);
  renderDeviceBar();
  render();
}

function selectDevice(dev) {
  activeDevice = dev;
  transform.attach(dev.group);
  transform.enabled = $("gizmoToggle").checked;
  transform.visible = $("gizmoToggle").checked;
  syncControlsToDevice();
  renderDeviceBar();
  render();
}

function renderDeviceBar() {
  const bar = $("deviceBar");
  // Keep the persistent Add Device button; rebuild only the chips after it.
  bar.querySelectorAll(".device-chip").forEach((c) => c.remove());
  devices.forEach((dev, i) => {
    const chip = document.createElement("div");
    chip.className = "device-chip" + (dev === activeDevice ? " active" : "");
    const label = document.createElement("span");
    label.textContent = `Device ${i + 1}`;
    label.addEventListener("click", () => selectDevice(dev));
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
}

$("addDevice").addEventListener("click", addDevice);

// Push the active device's settings/transform back into the controls.
function syncControlsToDevice() {
  if (!activeDevice) return;
  const s = activeDevice.settings;
  $("bodyColor").value = s.color;
  updateActiveSwatch(s.color);
  refreshTransformSliders();
}

// =====================================================================
// Screen image + assets library
// =====================================================================
const screenInput = $("screenInput");
const assets = []; // shared library: { blob, url }

function applyDeviceScreenTexture(dev) {
  const m = dev.screenMaterial;
  if (!m || !dev.uploadedTexture) return;
  m.map = null;
  m.color = new THREE.Color(0x000000);
  m.emissiveMap = dev.uploadedTexture;
  m.emissive = new THREE.Color(0xffffff);
  m.toneMapped = false;
  m.needsUpdate = true;
}

function applyDeviceFit(dev) {
  const t = dev.uploadedTexture;
  if (!t) return;
  const mode = dev.settings.fit;
  const imgAspect = dev.uploadedImageSize.w / dev.uploadedImageSize.h;
  t.repeat.set(1, 1);
  t.offset.set(0, 0);
  const wider = imgAspect > SCREEN_ASPECT;
  if (mode === "cover") {
    if (wider) {
      const r = SCREEN_ASPECT / imgAspect;
      t.repeat.set(r, 1);
      t.offset.set((1 - r) / 2, 0);
    } else {
      const r = imgAspect / SCREEN_ASPECT;
      t.repeat.set(1, r);
      t.offset.set(0, (1 - r) / 2);
    }
  } else if (mode === "contain") {
    if (wider) {
      const r = imgAspect / SCREEN_ASPECT;
      t.repeat.set(1, r);
      t.offset.set(0, (1 - r) / 2);
    } else {
      const r = SCREEN_ASPECT / imgAspect;
      t.repeat.set(r, 1);
      t.offset.set((1 - r) / 2, 0);
    }
  }
  t.repeat.x *= -1; // the screen's UVs are mirrored along U
  render();
}

// Apply any image (File/Blob) to a device's screen.
function applyScreenBlobToDevice(dev, blob) {
  dev.screenBlob = blob;
  const url = URL.createObjectURL(blob);
  new THREE.TextureLoader().load(url, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.center.set(0.5, 0.5);
    dev.uploadedImageSize = { w: tex.image.width, h: tex.image.height };
    dev.uploadedTexture = tex;
    applyDeviceScreenTexture(dev);
    applyDeviceFit(dev);
    URL.revokeObjectURL(url);
    setStatus("Screen image applied.");
    render();
  });
}

function addAsset(blob) {
  // de-dupe nothing fancy — just keep an entry with a thumbnail URL
  const url = URL.createObjectURL(blob);
  assets.push({ blob, url });
  renderAssets();
}

function renderAssets() {
  const row = $("assetRow");
  row.innerHTML = "";
  for (const a of assets) {
    const img = document.createElement("img");
    img.className = "asset-thumb";
    img.src = a.url;
    img.title = "Apply to selected device";
    img.addEventListener("click", () => {
      if (activeDevice) applyScreenBlobToDevice(activeDevice, a.blob);
    });
    row.appendChild(img);
  }
}

screenInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file || !activeDevice) return;
  addAsset(file);
  applyScreenBlobToDevice(activeDevice, file);
  screenInput.value = "";
});

$("clearScreen").addEventListener("click", () => {
  const dev = activeDevice;
  if (!dev || !dev.defaultScreenMaps) return;
  dev.screenMaterial.map = dev.defaultScreenMaps.map;
  dev.screenMaterial.emissiveMap = dev.defaultScreenMaps.emissiveMap;
  dev.screenMaterial.color = dev.defaultScreenMaps.color.clone();
  dev.screenMaterial.needsUpdate = true;
  dev.uploadedTexture = null;
  dev.screenBlob = null;
  setStatus("Screen reset. Re-add an image from the assets row.");
  render();
});

function applyDeviceBrightness(dev, value) {
  dev.settings.brightness = value;
  if (dev.screenMaterial) {
    dev.screenMaterial.emissiveIntensity = value;
    dev.screenMaterial.needsUpdate = true;
  }
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

// Format a value for the number box: integer degrees, or 3-dp metres.
function fmtAxis(v) {
  return mode === "rotate" ? String(Math.round(v)) : String(Math.round(v * 1000) / 1000);
}
// Current value of axis i (position in metres, or rotation in degrees).
function readAxis(i) {
  const g = activeDevice.group;
  return mode === "translate"
    ? g.position[AXES[i]]
    : THREE.MathUtils.radToDeg(g.rotation[AXES[i]]);
}
// Apply a value to axis i (clamped to the active mode's range). Returns clamped value.
function writeAxis(i, value) {
  const r = RANGES[mode];
  const v = Math.min(r.max, Math.max(r.min, value));
  const g = activeDevice.group;
  if (mode === "translate") g.position[AXES[i]] = v;
  else g.rotation[AXES[i]] = THREE.MathUtils.degToRad(v);
  return v;
}

function refreshTransformSliders() {
  if (!activeDevice) return;
  const r = RANGES[mode];
  for (let i = 0; i < 3; i++) {
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
  if (!activeDevice) return;
  const g = activeDevice.group;
  if (mode === "translate") {
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

// Scene: background is always transparent, env light is fixed at a good level.
const ENV_INTENSITY = 1.0;
scene.environmentIntensity = ENV_INTENSITY;

// =====================================================================
// Save → crop modal
// =====================================================================
const saveModal = $("saveModal");
const cropImg = $("cropImg");
const cropBox = $("cropBox");
const cropStage = $("cropStage");

function renderToBlob(scaleFactor = 2) {
  const prevRatio = renderer.getPixelRatio();
  const gizmoWasVisible = transform.visible;
  transform.visible = false;
  renderer.setPixelRatio(scaleFactor);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.render(scene, camera);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      transform.visible = gizmoWasVisible;
      renderer.setPixelRatio(prevRatio);
      onResize();
      resolve(blob);
    }, "image/png");
  });
}

$("savePng").addEventListener("click", async () => {
  setStatus("Rendering…");
  const blob = await renderToBlob(2);
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

  // Even gap on each side (~5% of the content's larger side, min 8px).
  const pad = Math.max(8, Math.round(0.05 * Math.max(bw, bh)));
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

$("cropDownload").addEventListener("click", () => {
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
    setStatus("Saved PNG.");
  }, "image/png");
});

// =====================================================================
// Render loop
// =====================================================================
let needsRender = true;
function render() {
  needsRender = true;
}
controls.addEventListener("change", render);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  if (needsRender) {
    renderer.render(scene, camera);
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
  return {
    camera: {
      position: camera.position.toArray().map(r4),
      target: controls.target.toArray().map(r4),
    },
    devices: devices.map((d) => ({
      pos: d.group.position.toArray().map(r4),
      rot: [d.group.rotation.x, d.group.rotation.y, d.group.rotation.z].map(r4),
      scale: d.group.scale.toArray().map(r4),
    })),
  };
}

function applyPreset(p) {
  if (!p || !p.devices?.length) return;
  // Carry the current screen images over by index so a test image survives.
  const blobs = devices.map((d) => d.screenBlob);
  for (const d of [...devices]) scene.remove(d.group);
  devices.length = 0;
  p.devices.forEach((pd, i) => {
    const dev = buildDevice();
    if (pd.pos) dev.group.position.fromArray(pd.pos);
    if (pd.rot) dev.group.rotation.set(pd.rot[0], pd.rot[1], pd.rot[2]);
    if (pd.scale) dev.group.scale.fromArray(pd.scale);
    if (blobs[i]) applyScreenBlobToDevice(dev, blobs[i]);
  });
  if (p.camera) {
    camera.position.fromArray(p.camera.position);
    controls.target.fromArray(p.camera.target);
    controls.update();
  }
  selectDevice(devices[0]);
  renderDeviceBar();
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
    devices: devices.map((d) => ({
      settings: { ...d.settings },
      pos: d.group.position.toArray(),
      rot: [d.group.rotation.x, d.group.rotation.y, d.group.rotation.z],
      scale: d.group.scale.toArray(),
    })),
  };
}

async function applySceneState(state, imagePaths) {
  if (!state) return;
  // Clear existing devices.
  for (const d of [...devices]) scene.remove(d.group);
  devices.length = 0;
  for (let i = 0; i < (state.devices?.length || 0); i++) {
    const ds = state.devices[i];
    const dev = buildDevice();
    applyDeviceColor(dev, ds.settings.color);
    applyDeviceFinish(dev, ds.settings.finish);
    applyDeviceBrightness(dev, ds.settings.brightness);
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
  headerSignedOut.hidden = !!user;
  headerSignedIn.hidden = !user;
  cloudGroup.hidden = !user;
  if (user) {
    $("userEmail").textContent = user.email;
    authModal.hidden = true; // close the modal once signed in
    refreshMockups();
  } else {
    mockupList.innerHTML = "";
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
  const name = prompt("Name this mockup:", "My mockup");
  if (name === null) return;
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
