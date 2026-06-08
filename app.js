import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

const MODEL_URL = "iphone-17-pro/source/iPhone%2017%20Pro.glb";
const ENV_URL = "studio_small_08_4k.exr";

const canvas = document.getElementById("stage");
const statusEl = document.getElementById("status");
const loadingEl = document.getElementById("loading");
const setStatus = (m) => (statusEl.textContent = m);

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true, // needed so we can export the canvas at any time
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// --- Scene & camera ---
const scene = new THREE.Scene();
scene.background = new THREE.Color("#15161a");

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
camera.position.set(0, 0.05, 0.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.15;
controls.maxDistance = 3;

// A holder we transform with the gizmo; the model lives inside it.
const phone = new THREE.Group();
scene.add(phone);

// --- Transform gizmo ---
const transform = new TransformControls(camera, renderer.domElement);
transform.setSize(0.8);
transform.attach(phone);
scene.add(transform);
transform.addEventListener("dragging-changed", (e) => {
  controls.enabled = !e.value; // don't orbit while dragging the gizmo
});

let screenMaterial = null;
let defaultScreenMaps = null; // remember original maps to allow "reset screen"
let uploadedTexture = null;
let uploadedImageSize = { w: 1, h: 1 };
const bodyMaterials = {}; // frame (sides + back), antenna lines, back accent

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

// fallback / fill lights so it's never pitch black
const key = new THREE.DirectionalLight(0xffffff, 2);
key.position.set(1, 2, 2);
scene.add(key);
scene.add(new THREE.AmbientLight(0xffffff, 0.3));

// --- Load the model ---
new GLTFLoader().load(
  MODEL_URL,
  (gltf) => {
    const model = gltf.scene;

    // Center the model at the origin and normalize its size.
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    model.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 0.16 / maxDim; // fit to a friendly camera framing
    model.scale.setScalar(scale);
    model.rotation.y = Math.PI; // turn the screen to face the camera by default
    phone.add(model);

    // Find the screen material ("OLED" emissive display) and tune the cover glass.
    model.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.name === "OLED") {
          screenMaterial = m;
          defaultScreenMaps = { map: m.map, emissiveMap: m.emissiveMap, color: m.color.clone() };
          // Show the screen at its true pixel values: skip the scene's ACES tone
          // mapping (which would wash out and desaturate a flat UI screenshot).
          m.toneMapped = false;
        }
        if (m.name === "Glass") {
          // The cover glass ships as 78%-opaque black, which heavily dims the
          // screen behind it. Make it nearly clear so the display reads true.
          m.opacity = 0.08;
          m.needsUpdate = true;
        }
        // Collect the body materials we recolor / de-sparkle.
        if (m.name === "Anodized aluminum") bodyMaterials.frame = m;
        if (m.name === "Plastic antena") bodyMaterials.antenna = m;
        if (m.name === "Frosted glass") bodyMaterials.back = m;
      }
    });

    // Tame the sparkle: the aluminum ships glossy (roughness ~0.24) with a strong
    // normal map, which fizzes under the sharp studio reflections. A satin finish
    // with a gentler normal map reads like a real anodized phone body.
    for (const m of Object.values(bodyMaterials)) {
      if (m && m.normalScale) m.normalScale.set(0.1, -0.1);
    }
    if (bodyMaterials.frame) bodyMaterials.frame.metalness = 0.6;

    loadingEl.classList.add("hidden");
    setStatus(screenMaterial ? "Ready. Upload an image for the screen." : "Ready (screen mesh not found).");
    setupBodyColor();
    applyBrightness();
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

// --- Screen image upload ---
const screenInput = document.getElementById("screenInput");
screenInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  new THREE.TextureLoader().load(url, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false; // match glTF UV convention
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.center.set(0.5, 0.5);
    uploadedImageSize = { w: tex.image.width, h: tex.image.height };
    uploadedTexture = tex;
    applyScreenTexture();
    applyFit();
    URL.revokeObjectURL(url);
    setStatus("Screen image applied.");
    render();
  });
});

function applyScreenTexture() {
  if (!screenMaterial || !uploadedTexture) return;
  // Drive the display purely from the emissive channel so the image glows like
  // a real screen and stays vivid regardless of environment lighting.
  screenMaterial.map = null;
  screenMaterial.color = new THREE.Color(0x000000);
  screenMaterial.emissiveMap = uploadedTexture;
  screenMaterial.emissive = new THREE.Color(0xffffff);
  screenMaterial.toneMapped = false;
  screenMaterial.needsUpdate = true;
}

// Aspect of the phone screen UV region (iPhone 17 Pro ≈ 1206×2622).
const SCREEN_ASPECT = 1206 / 2622;
function applyFit() {
  if (!uploadedTexture) return;
  const mode = document.getElementById("fitMode").value;
  const t = uploadedTexture;
  const imgAspect = uploadedImageSize.w / uploadedImageSize.h;
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
  // The screen's UVs are mirrored along U, so flip horizontally (about center)
  // to keep uploaded images reading the right way round.
  t.repeat.x *= -1;
  render();
}
document.getElementById("fitMode").addEventListener("change", applyFit);

document.getElementById("clearScreen").addEventListener("click", () => {
  if (!screenMaterial || !defaultScreenMaps) return;
  screenMaterial.map = defaultScreenMaps.map;
  screenMaterial.emissiveMap = defaultScreenMaps.emissiveMap;
  screenMaterial.color = defaultScreenMaps.color;
  screenMaterial.needsUpdate = true;
  uploadedTexture = null;
  screenInput.value = "";
  setStatus("Screen reset.");
  render();
});

function applyBrightness() {
  if (!screenMaterial) return;
  screenMaterial.emissiveIntensity = parseFloat(document.getElementById("brightness").value);
  screenMaterial.needsUpdate = true;
}
document.getElementById("brightness").addEventListener("input", () => {
  applyBrightness();
  render();
});

// --- Phone body color ---
// Real iPhone 17 Pro finishes (approximate anodized-aluminum tints).
const COLOR_PRESETS = [
  { name: "Silver", hex: "#c9ccce" },
  { name: "Deep Blue", hex: "#2e4257" },
  { name: "Cosmic Orange", hex: "#c8623a" },
  { name: "Black", hex: "#2b2b2e" },
  { name: "Natural", hex: "#9a948b" },
];
const bodyColorInput = document.getElementById("bodyColor");
const swatchesEl = document.getElementById("swatches");
const finishInput = document.getElementById("finish");

function setBodyColor(hex) {
  bodyColorInput.value = hex;
  const c = new THREE.Color(hex);
  if (bodyMaterials.frame) bodyMaterials.frame.color.copy(c);
  // Antenna lines and back read as a slightly lighter shade of the body color.
  const lighter = c.clone().lerp(new THREE.Color(0xffffff), 0.15);
  if (bodyMaterials.antenna) bodyMaterials.antenna.color.copy(lighter);
  if (bodyMaterials.back) bodyMaterials.back.color.copy(c);
  // Mark the matching swatch active.
  [...swatchesEl.children].forEach((s) =>
    s.classList.toggle("active", s.dataset.hex.toLowerCase() === hex.toLowerCase())
  );
  render();
}

function applyFinish() {
  const r = parseFloat(finishInput.value);
  for (const m of Object.values(bodyMaterials)) if (m) m.roughness = r;
  render();
}

function setupBodyColor() {
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
  applyFinish();
  setBodyColor(COLOR_PRESETS[0].hex); // default to Silver
}
bodyColorInput.addEventListener("input", () => setBodyColor(bodyColorInput.value));
finishInput.addEventListener("input", applyFinish);

// --- Transform gizmo modes ---
const modeButtons = [...document.querySelectorAll(".mode")];
function setMode(mode) {
  transform.setMode(mode);
  modeButtons.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  render();
}
modeButtons.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

document.getElementById("gizmoToggle").addEventListener("change", (e) => {
  transform.enabled = e.target.checked;
  transform.visible = e.target.checked;
  render();
});

// Rotation sliders (drive the phone group directly).
const rotY = document.getElementById("rotY");
const rotX = document.getElementById("rotX");
function applySliderRotation() {
  phone.rotation.set(
    THREE.MathUtils.degToRad(parseFloat(rotX.value)),
    THREE.MathUtils.degToRad(parseFloat(rotY.value)),
    phone.rotation.z
  );
  render();
}
rotY.addEventListener("input", applySliderRotation);
rotX.addEventListener("input", applySliderRotation);

document.getElementById("resetXform").addEventListener("click", () => {
  phone.position.set(0, 0, 0);
  phone.rotation.set(0, 0, 0);
  phone.scale.setScalar(1);
  rotY.value = 0;
  rotX.value = 0;
  setMode("translate");
  render();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "w") setMode("translate");
  if (e.key === "e") setMode("rotate");
  if (e.key === "r") setMode("scale");
});

// --- Scene controls ---
const bgColor = document.getElementById("bgColor");
const transparentBg = document.getElementById("transparentBg");
function applyBackground() {
  scene.background = transparentBg.checked ? null : new THREE.Color(bgColor.value);
  render();
}
bgColor.addEventListener("input", applyBackground);
transparentBg.addEventListener("change", applyBackground);

document.getElementById("envIntensity").addEventListener("input", (e) => {
  scene.environmentIntensity = parseFloat(e.target.value);
  render();
});

// --- Save PNG ---
document.getElementById("savePng").addEventListener("click", () => {
  const scaleFactor = parseInt(document.getElementById("exportScale").value, 10);
  const prevRatio = renderer.getPixelRatio();

  // Render at higher resolution for a crisp export, then restore.
  renderer.setPixelRatio(scaleFactor);
  const gizmoWasVisible = transform.visible;
  transform.visible = false;
  renderer.render(scene, camera);

  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `iphone-mockup-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(a.href);

    transform.visible = gizmoWasVisible;
    renderer.setPixelRatio(prevRatio);
    onResize();
    setStatus(`Saved PNG at ${scaleFactor}×.`);
  }, "image/png");
});

// --- Render loop (render-on-demand + damping) ---
let needsRender = true;
function render() {
  needsRender = true;
}
controls.addEventListener("change", render);
transform.addEventListener("change", render);
transform.addEventListener("objectChange", render);

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
