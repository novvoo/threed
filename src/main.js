import * as THREE from 'three/webgpu';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { SPZLoader } from 'three/addons/loaders/SPZLoader.js';
import { SPLATLoader } from 'three/addons/loaders/SPLATLoader.js';
import { GaussianSplatPLYLoader } from 'three/addons/loaders/GaussianSplatPLYLoader.js';
import { KSPLATLoader } from 'three/addons/loaders/KSPLATLoader.js';

// ---------------------------------------------------------------- renderer / scene
const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const webgpuError = document.getElementById('webgpu-error');

let renderer;
try {
  renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
} catch (e) {
  console.error(e);
  webgpuError.style.display = 'flex';
  throw e;
}
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

THREE.ColorManagement.workingColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080f);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(0, 0.35, 3.2);

// TrackballControls：任意方向无限翻转（绕 X/Y 轴都不限角度），左键旋转、滚轮缩放、右键平移
const controls = new TrackballControls(camera, renderer.domElement);
controls.rotateSpeed = 4;
controls.zoomSpeed = 1.2;
controls.panSpeed = 0.8;
controls.dynamicDampingFactor = 0.15;

// ---------------------------------------------------------------- splat loading
const splatRoot = new THREE.Group();
scene.add(splatRoot);

let currentSplats = null;

function disposeCurrentSplats() {
  if (!currentSplats) return;
  splatRoot.remove(currentSplats);
  currentSplats.geometry.dispose();
  currentSplats.material.dispose();
  currentSplats = null;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function frameSplats(splats, view) {
  if (view.camera) {
    camera.position.set(...view.camera);
    controls.target.set(0, 0, 0);
  } else {
    // 本地文件没有预设机位，用包围球自动取景
    splats.geometry.computeBoundingSphere();
    const radius = splats.geometry.boundingSphere?.radius || 1;
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.15;
    camera.position.set(0, radius * 0.2, dist);
    controls.target.set(0, 0, 0);
  }
  camera.near = 0.01;
  camera.far = 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function loaderForFile(name) {
  const ext = name.split('.').pop().toLowerCase();
  switch (ext) {
    case 'spz': return new SPZLoader();
    case 'ply': return new GaussianSplatPLYLoader();
    case 'splat': return new SPLATLoader();
    case 'ksplat': return new KSPLATLoader();
    default: throw new Error(`不支持的格式: .${ext}（支持 .spz / .ply / .splat / .ksplat）`);
  }
}

async function showSplats(geometry, view) {
  disposeCurrentSplats();
  if (view.rotation) {
    const [x, y, z] = view.rotation;
    geometry.rotateX(x); geometry.rotateY(y); geometry.rotateZ(z);
  }
  const splats = new GaussianSplat(geometry);
  splatRoot.add(splats);
  currentSplats = splats;
  frameSplats(splats, view);
}

// 模型没有预设机位，统一按包围球自动取景；TripoSplat 导出的 PLY 为 Y 朝下，绕 X 轴翻正
function viewForModel(name) {
  return name.toLowerCase().endsWith('.ply') ? { rotation: [Math.PI, 0, 0] } : {};
}

async function loadUrl(url, label) {
  setStatus(`加载中：${label} …`);
  try {
    const geometry = await loaderForFile(url).loadAsync(url);
    await showSplats(geometry, viewForModel(url));
    setCurrentModel(url);
    activeModelUrl = url;
    renderModelList();
    setStatus(`已加载 ${label} · ${geometry.attributes.position.count.toLocaleString()} splats`);
  } catch (e) {
    console.error(e);
    setStatus(`加载失败：${e.message}`);
  }
}

async function loadFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
    convertImageToSplat(file);
    return;
  }
  setStatus(`加载中：${file.name} …`);
  try {
    const loader = loaderForFile(file.name);
    const url = URL.createObjectURL(file);
    try {
      const geometry = await loader.loadAsync(url);
      await showSplats(geometry, {});
      setCurrentModel(null); // blob 加载的本地文件无持久 URL，不提供下载
      setStatus(`已加载 ${file.name} · ${geometry.attributes.position.count.toLocaleString()} splats`);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    console.error(e);
    setStatus(`加载失败：${e.message}`);
  }
}

// ---------------------------------------------------------------- 后端初始化（拉取仓库 + 下载模型，网页一键完成）
const setupCapsule = document.getElementById('setup-capsule');
const setupDot = setupCapsule.querySelector('.dot');
const setupBtn = document.getElementById('setup-btn');
const cancelSetupBtn = document.getElementById('cancel-setup-btn');
let settingUp = false;

function updateBackendUI(info) {
  // 胶囊常驻右上角、始终可点：未就绪→点击初始化；就绪→点击可重新配置；进行中→中断
  setupCapsule.hidden = false;
  setupDot.classList.toggle('ready', !!info.available);
  settingUp = info.setup?.status === 'running';
  setupBtn.textContent = settingUp ? '初始化中…'
    : info.available ? '后端就绪 · 设置' : '后端未就绪 · 点击初始化';
  cancelSetupBtn.hidden = !settingUp;
}

async function checkBackend() {
  try {
    return await (await fetch('/api/triposplat/status')).json();
  } catch {
    return { available: false };
  }
}

const setupModal = document.getElementById('setup-modal');
const setupRepoInput = document.getElementById('setup-repo');
const setupModelInput = document.getElementById('setup-model');

setupBtn.addEventListener('click', async () => {
  // 先弹配置：可修改生成器仓库与模型下载源
  try {
    const cfg = await (await fetch('/api/triposplat/setup')).json();
    setupRepoInput.value = cfg.repo || '';
    setupModelInput.value = cfg.model || '';
  } catch {}
  setupModal.style.display = 'flex';
});

document.getElementById('setup-cancel').addEventListener('click', () => {
  setupModal.style.display = 'none';
  setupBtn.hidden = false;
});

document.getElementById('setup-start').addEventListener('click', async () => {
  setupModal.style.display = 'none';
  settingUp = true;
  setupBtn.hidden = true;
  cancelSetupBtn.hidden = false;
  setStatus('初始化后端：拉取仓库 → 建 venv → 下载模型权重（约 4.2GB）…');
  try {
    const resp = await fetch('/api/triposplat/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: setupRepoInput.value, model: setupModelInput.value }),
    });
    if (!resp.ok) throw new Error((await resp.json()).error || `HTTP ${resp.status}`);
    while (true) {
      await new Promise((r) => setTimeout(r, 2000));
      const info = await checkBackend();
      const s = info.setup || {};
      if (s.stage) setStatus(`初始化后端：${s.stage}`);
      updateBackendUI({ ...info, available: false });
      if (info.available) {
        setStatus('TripoSplat 后端已就绪，可以拖入图片转换 3D 了');
        break;
      }
      if (s.status === 'error') {
        setStatus(`初始化失败：${s.error}`);
        break;
      }
    }
  } catch (e) {
    setStatus(`初始化失败：${e.message}`);
  }
  settingUp = false;
  updateBackendUI(await checkBackend());
});

cancelSetupBtn.addEventListener('click', async () => {
  await fetch('/api/triposplat/setup', { method: 'DELETE' });
  setStatus('已请求中断初始化');
});

// 页面加载时检查后端，不可用则显示一键初始化按钮
(async () => {
  updateBackendUI(await checkBackend());
})();

// ---------------------------------------------------------------- 下载 / 中断 / 任务恢复
const downloadBtn = document.getElementById('download-btn');
const cancelConvertBtn = document.getElementById('cancel-convert-btn');
const lastJobBtn = document.getElementById('last-job-btn');

let currentModelUrl = null; // 当前展示模型的 URL（blob 加载的本地文件不可下载）
let activeJobId = null;

function setCurrentModel(url) {
  currentModelUrl = url;
  downloadBtn.hidden = !url;
}

// ---------------------------------------------------------------- 可预览 HTML 生成（模型 base64 内嵌，双击即可打开）
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------- 零依赖 zip 打包（store 模式，不压缩）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data: Uint8Array }]
function makeZip(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = encoder.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);            // version needed
    dv.setUint16(8, 0, true);             // store，不压缩
    dv.setUint32(14, crc, true);
    dv.setUint32(18, e.data.length, true);
    dv.setUint32(22, e.data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, e.data);
    central.push({ nameBytes, crc, size: e.data.length, offset });
    offset += local.length + e.data.length;
  }
  const centralStart = offset;
  const centralParts = [];
  for (const c of central) {
    const h = new Uint8Array(46 + c.nameBytes.length);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);            // writer version
    dv.setUint16(6, 20, true);            // version needed
    dv.setUint16(8, 0, true);             // store
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.size, true);
    dv.setUint32(24, c.size, true);
    dv.setUint16(28, c.nameBytes.length, true);
    dv.setUint32(42, c.offset, true);
    h.set(c.nameBytes, 46);
    centralParts.push(h);
    offset += h.length;
  }
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, central.length, true);
  dv.setUint16(10, central.length, true);
  dv.setUint32(12, offset - centralStart, true);
  dv.setUint32(16, centralStart, true);
  return new Blob([...parts, ...centralParts, eocd], { type: 'application/zip' });
}

function buildPreviewHtml(modelName, modelBytes) {
  const b64 = toBase64(modelBytes);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Gaussian Splat 预览 - ${JSON.stringify(modelName).slice(1, -1)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { overflow:hidden; background:#07080f; font-family:-apple-system,"PingFang SC",sans-serif; }
  #app { position:fixed; inset:0; }
  #tip { position:fixed; top:12px; left:12px; z-index:10; color:#8a90a3; font-size:12px;
         background:rgba(10,12,20,0.7); backdrop-filter:blur(10px); padding:8px 12px;
         border-radius:10px; border:1px solid rgba(255,255,255,0.08); }
  #err { position:fixed; inset:0; z-index:30; display:none; align-items:center; justify-content:center;
         text-align:center; color:#dfe3ee; padding:24px; line-height:1.7; }
</style>
<script type="importmap">
{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.webgpu.js","three/webgpu":"https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.webgpu.js","three/tsl":"https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.tsl.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/"}}
</script>
</head>
<body>
<div id="app"></div>
<div id="tip">拖动旋转 · 滚轮缩放 · 右键平移</div>
<div id="err"><div>当前浏览器不支持 WebGPU。<br/>请使用 Chrome / Edge 113+ 或 Safari 18+ 打开本文件。</div></div>
<script type="module">
import * as THREE from 'three/webgpu';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { SPZLoader } from 'three/addons/loaders/SPZLoader.js';
import { SPLATLoader } from 'three/addons/loaders/SPLATLoader.js';
import { GaussianSplatPLYLoader } from 'three/addons/loaders/GaussianSplatPLYLoader.js';
import { KSPLATLoader } from 'three/addons/loaders/KSPLATLoader.js';

const MODEL_B64 = '${b64}';

let renderer;
try {
  renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
} catch (e) {
  document.getElementById('err').style.display = 'flex';
  throw e;
}
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.getElementById('app').appendChild(renderer.domElement);
THREE.ColorManagement.workingColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080f);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 100);
const controls = new TrackballControls(camera, renderer.domElement);
controls.rotateSpeed = 4;
controls.zoomSpeed = 1.2;
controls.panSpeed = 0.8;
controls.dynamicDampingFactor = 0.15;

// 解码内嵌模型数据为 Blob URL
const bytes = Uint8Array.from(atob(MODEL_B64), (c) => c.charCodeAt(0));
const url = URL.createObjectURL(new Blob([bytes]));

const ext = '${JSON.stringify(modelName).slice(1, -1)}'.split('.').pop().toLowerCase();
const loader = { spz: SPZLoader, ply: GaussianSplatPLYLoader, splat: SPLATLoader, ksplat: KSPLATLoader }[ext];
const geometry = await new loader().loadAsync(url);

// TripoSplat 导出的 PLY 为 Y 朝下约定，绕 X 轴翻正
if (ext === 'ply') geometry.rotateX(Math.PI);

const splat = new GaussianSplat(geometry);
scene.add(splat);

// 按包围球自动取景
geometry.computeBoundingSphere();
const radius = geometry.boundingSphere?.radius || 1;
const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.15;
camera.position.set(0, radius * 0.2, dist);
controls.update();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
</script>
</body>
</html>`;
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

downloadBtn.addEventListener('click', async () => {
  if (!currentModelUrl) return;
  setStatus('正在打包下载…');
  try {
    const group = modelGroups.find((g) => g.files.some((f) => f.url === currentModelUrl));
    const entries = [];
    if (group) {
      // 该模型的所有格式产物（.ply + .splat 等）一起打包
      for (const f of group.files) {
        entries.push({ name: f.name, data: new Uint8Array(await (await fetch(f.url)).arrayBuffer()) });
      }
      var modelName = group.primary.name;
    } else {
      // 兜底：找不到分组信息时只打包当前模型
      modelName = currentModelUrl.split('/').pop();
      entries.push({ name: modelName, data: new Uint8Array(await (await fetch(currentModelUrl)).arrayBuffer()) });
    }
    // 内嵌 primary 模型数据的可预览 HTML
    const html = buildPreviewHtml(modelName, entries[0].data);
    const base = modelName.replace(/\.[^.]+$/, '');
    entries.push({ name: `${base}.preview.html`, data: new TextEncoder().encode(html) });
    downloadBlob(makeZip(entries), `${base}.zip`);
    setStatus(`已下载 ${base}.zip（${entries.length - 1} 个模型文件 + 预览 HTML，双击 HTML 即可预览，需联网加载 three.js CDN）`);
  } catch (e) {
    setStatus(`下载失败：${e.message}`);
  }
});

function setConvertingUI(on) {
  cancelConvertBtn.hidden = !on;
}

cancelConvertBtn.addEventListener('click', async () => {
  if (!activeJobId) return;
  await fetch(`/api/triposplat/job/${activeJobId}`, { method: 'DELETE' });
  setStatus('已请求中断生成任务');
});

function startConversionUI(jobId) {
  if (!converting) {
    // 页面刷新后恢复：不经过弹窗，直接进入轮询
    modalProgress.classList.add('visible');
    modalCancel.textContent = '后台运行'; // 与正常转换路径一致，刷新恢复前按钮残留「取消」文案
    converting = true;
    pollJob(jobId);
  }
}

// 页面加载时恢复未完成的任务
(async () => {
  try {
    const cur = await (await fetch('/api/triposplat/current')).json();
    if (!cur) return;
    if (cur.status === 'running') {
      startConversionUI(cur.jobId);
      setStatus(`恢复生成任务：${cur.stage} ${cur.progress}%`);
      modalBackdrop.classList.add('visible');
    } else if (cur.status === 'done' && cur.plyUrl) {
      lastJobBtn.hidden = false;
      lastJobBtn.onclick = () => {
        lastJobBtn.hidden = true;
        loadGeneratedPly(cur.plyUrl);
      };
      setStatus('检测到上次生成已完成，可点击「加载上次生成结果」');
    }
  } catch { /* 后端不可用，忽略 */ }
})();

async function loadGeneratedPly(url) {
  setStatus('加载生成结果…');
  try {
    const geometry = await new GaussianSplatPLYLoader().loadAsync(url);
    await showSplats(geometry, viewForModel(url));
    setCurrentModel(url);
    activeModelUrl = url;
    setStatus(`已加载生成结果 · ${geometry.attributes.position.count.toLocaleString()} splats`);
    refreshModelList(); // 新生成的模型会出现在列表最前
  } catch (e) {
    setStatus(`加载失败：${e.message}`);
  }
}
// ---------------------------------------------------------------- 图片 → TripoSplat 转换
const modalBackdrop = document.getElementById('modal-backdrop');
const modalPreview = document.getElementById('modal-preview');
const modalProgress = document.getElementById('modal-progress');
const modalProgressFill = modalProgress.querySelector('.progress-fill');
const modalStatus = document.getElementById('modal-status');
const modalOk = document.getElementById('modal-ok');
const modalCancel = document.getElementById('modal-cancel');

let pendingImage = null;
let converting = false;

// ---------------------------------------------------------------- 白底智能移除
// 从图片四边泛洪填充，把与白底连通的近白像素变透明（内部高光不受影响）。
// 输入/输出均为 {data,width,height} 的 RGBA 像素对象，便于脱离 DOM 测试。
function removeWhiteBackgroundPixels(img, { borderMinRatio = 0.55, whiteLevel = 225, maxSpread = 26 } = {}) {
  const { width: w, height: h } = img;
  const d = img.data;
  const isNearWhite = (i) => {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    return r >= whiteLevel && g >= whiteLevel && b >= whiteLevel && Math.max(r, g, b) - Math.min(r, g, b) <= maxSpread;
  };
  // 边框近白占比不足则认为不是白底图，直接跳过
  let borderTotal = 0, borderWhite = 0;
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) {
    borderTotal++;
    if (isNearWhite((y * w + x) * 4)) borderWhite++;
  }
  for (let y = 1; y < h - 1; y++) for (const x of [0, w - 1]) {
    borderTotal++;
    if (isNearWhite((y * w + x) * 4)) borderWhite++;
  }
  if (borderWhite / borderTotal < borderMinRatio) return false;

  const visited = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const p = y * w + x;
    if (!visited[p] && isNearWhite(p * 4)) { visited[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    d[p * 4 + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  // 边缘羽化：与透明区相邻的不透明像素降一点 alpha，避免生硬锯齿
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (d[p * 4 + 3] === 0) continue;
    let transparentNeighbors = 0;
    if (x > 0 && d[(p - 1) * 4 + 3] === 0) transparentNeighbors++;
    if (x < w - 1 && d[(p + 1) * 4 + 3] === 0) transparentNeighbors++;
    if (y > 0 && d[(p - w) * 4 + 3] === 0) transparentNeighbors++;
    if (y < h - 1 && d[(p + w) * 4 + 3] === 0) transparentNeighbors++;
    if (transparentNeighbors >= 2) d[p * 4 + 3] = 128;
  }
  return true;
}

async function maybeRemoveWhiteBackground(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const removed = removeWhiteBackgroundPixels(imageData);
  if (!removed) return { file, removed: false };
  ctx.putImageData(imageData, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const name = file.name.replace(/\.(png|jpe?g|webp)$/i, '') + '_nobg.png';
  return { file: new File([blob], name, { type: 'image/png' }), removed: true };
}

async function convertImageToSplat(file) {
  setStatus('检测 TripoSplat 后端…');
  let available;
  try {
    available = (await (await fetch('/api/triposplat/status')).json()).available;
  } catch {
    available = false;
  }
  if (!available) {
    setStatus('无法转换：本地 TripoSplat 后端不可用，可点「初始化后端」一键拉取仓库并下载模型');
    updateBackendUI(await checkBackend());
    return;
  }
  // 白底图自动转透明（内部高光不受影响），再送转换
  setStatus('分析图片背景…');
  let bgRemoved = false;
  try {
    ({ file, removed: bgRemoved } = await maybeRemoveWhiteBackground(file));
  } catch (e) {
    console.warn('白底处理失败，使用原图', e);
  }
  if (bgRemoved) setStatus('检测到白底，已自动移除');
  // 弹窗确认
  pendingImage = file;
  modalPreview.src = URL.createObjectURL(file);
  modalProgress.classList.remove('visible');
  modalStatus.textContent = '';
  modalOk.textContent = '开始生成';
  modalOk.disabled = false;
  modalBackdrop.classList.add('visible');
}

modalCancel.addEventListener('click', () => {
  if (converting) {
    // 任务在后台继续，状态显示在左下角状态栏
    modalBackdrop.classList.remove('visible');
    return;
  }
  modalBackdrop.classList.remove('visible');
  if (modalPreview.src.startsWith('blob:')) URL.revokeObjectURL(modalPreview.src);
  pendingImage = null;
  setStatus('已取消转换');
});

modalOk.addEventListener('click', async () => {
  if (!pendingImage || converting) return;
  converting = true;
  modalOk.disabled = true;
  modalStatus.textContent = '正在提交任务…';
  try {
    const buf = await pendingImage.arrayBuffer();
    const resp = await fetch('/api/triposplat/convert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(pendingImage.name),
      },
      body: buf,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    modalProgress.classList.add('visible');
    modalCancel.textContent = '后台运行';
    await pollJob(data.jobId);
  } catch (e) {
    console.error(e);
    modalStatus.textContent = `提交失败：${e.message}`;
    converting = false;
    modalOk.disabled = false;
  }
});

async function pollJob(jobId) {
  activeJobId = jobId;
  setConvertingUI(true);
  const startedAt = Date.now();
  let job;
  while (true) {
    try {
      job = await (await fetch(`/api/triposplat/job/${jobId}`)).json();
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (job.status === 'cancelled') {
      modalStatus.textContent = '任务已中断';
      setStatus('生成任务已中断');
      break;
    }
    const mins = Math.floor((Date.now() - startedAt) / 60000);
    const secs = Math.floor(((Date.now() - startedAt) % 60000) / 1000);
    if (job.status === 'running') {
      const eta = job.progress > 12 ? ` · 剩余约 ${Math.ceil((100 - job.progress) / 100 * 13)} 分钟` : ' · 正在加载模型';
      const text = `${job.stage} ${job.progress}%（已用 ${mins}:${String(secs).padStart(2, '0')}${eta}）`;
      modalStatus.textContent = text;
      setStatus(`TripoSplat 转换中：${job.stage} ${job.progress}%（点「中断生成任务」可停止）`);
      modalProgressFill.style.width = `${job.progress}%`;
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (job.status === 'done') {
      modalStatus.textContent = '生成完成，正在加载…';
      modalProgressFill.style.width = '100%';
      setStatus(`加载 TripoSplat 生成结果…`);
      await loadGeneratedPly(job.plyUrl);
      modalStatus.textContent = '完成';
    } else {
      modalStatus.textContent = `转换失败：${job.error}`;
      setStatus(`TripoSplat 转换失败：${job.error}`);
    }
    break;
  }
  converting = false;
  activeJobId = null;
  setConvertingUI(false);
  modalOk.disabled = false;
  modalOk.textContent = '完成';
  setTimeout(() => {
    modalBackdrop.classList.remove('visible');
    modalCancel.textContent = '取消';
    if (modalPreview.src.startsWith('blob:')) URL.revokeObjectURL(modalPreview.src);
    pendingImage = null;
  }, job?.status === 'done' ? 1500 : 0);
}

// ---------------------------------------------------------------- 模型列表（动态读取 /models 目录，支持重命名/删除/去重）
const modelList = document.getElementById('model-list');
const dedupeBtn = document.getElementById('dedupe-btn');

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

let activeModelUrl = null;
let modelFiles = [];

// 按主文件名聚合（.ply / .splat 等多格式产物显示为一个条目），点击优先加载 .ply
function groupModels(files) {
  const map = new Map();
  for (const f of files) {
    const base = f.name.replace(/\.(spz|ply|splat|ksplat)$/i, '');
    if (!map.has(base)) map.set(base, []);
    map.get(base).push(f);
  }
  return [...map.entries()].map(([base, files]) => ({
    base,
    files,
    primary: files.find((f) => f.name.toLowerCase().endsWith('.ply')) || files[0],
  }));
}

let modelGroups = [];

function renderModelList() {
  modelGroups = groupModels(modelFiles);
  modelList.textContent = '';
  if (!modelGroups.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有模型，拖入图片生成或往 public/models/ 放文件';
    modelList.appendChild(empty);
  }
  modelGroups.forEach((g) => {
    const totalSize = g.files.reduce((s, f) => s + f.size, 0);
    const row = document.createElement('div');
    row.className = 'model-row';

    const name = document.createElement('button');
    name.className = 'model-name' + (g.files.some((f) => f.url === activeModelUrl) ? ' active' : '');
    name.title = `${g.base}（${fmtSize(totalSize)}${g.files.length > 1 ? ` · ${g.files.length} 个格式` : ''}）`;
    name.textContent = g.base;
    if (g.primary.dup) {
      const tag = document.createElement('span');
      tag.className = 'dup-tag';
      tag.textContent = '重复';
      name.appendChild(tag);
    }
    name.addEventListener('click', () => loadUrl(g.primary.url, g.base));
    row.appendChild(name);

    const rename = document.createElement('button');
    rename.className = 'model-act';
    rename.textContent = '✎';
    rename.title = '重命名';
    rename.addEventListener('click', () => renameModel(g));
    row.appendChild(rename);

    const del = document.createElement('button');
    del.className = 'model-act del';
    del.textContent = '✕';
    del.title = '删除';
    del.addEventListener('click', () => deleteModel(g));
    row.appendChild(del);

    modelList.appendChild(row);
  });
  dedupeBtn.hidden = !modelFiles.some((f) => f.dup);
}

async function refreshModelList() {
  try {
    modelFiles = await (await fetch('/api/models')).json();
  } catch {
    /* 后端不可用时保留现状 */
  }
  renderModelList();
}

async function postModelAction(action, payload) {
  const resp = await fetch(`/api/models/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

async function renameModel(group) {
  const input = prompt('重命名模型：', group.base);
  if (input === null) return;
  const next = input.trim();
  if (!next || next === group.base) return;
  try {
    for (const f of group.files) {
      await postModelAction('rename', { from: f.name, to: next + f.name.slice(group.base.length) });
    }
    if (group.files.some((f) => f.url === activeModelUrl)) {
      activeModelUrl = activeModelUrl.replace(`/${group.base}.`, `/${next}.`);
    }
    await refreshModelList();
    setStatus(`已重命名为 ${next}`);
  } catch (e) {
    setStatus(`重命名失败：${e.message}`);
    await refreshModelList();
  }
}

async function deleteModel(group) {
  if (!confirm(`删除模型「${group.base}」（共 ${group.files.length} 个文件）？此操作不可恢复。`)) return;
  try {
    for (const f of group.files) {
      await postModelAction('delete', { name: f.name });
    }
    if (group.files.some((f) => f.url === activeModelUrl)) {
      disposeCurrentSplats();
      setCurrentModel(null);
      activeModelUrl = null;
      setStatus('已删除当前展示的模型');
    }
    await refreshModelList();
    setStatus(`已删除 ${group.base}`);
  } catch (e) {
    setStatus(`删除失败：${e.message}`);
    await refreshModelList();
  }
}

dedupeBtn.addEventListener('click', async () => {
  dedupeBtn.disabled = true;
  try {
    const { removed = [] } = await postModelAction('dedupe', {});
    setStatus(removed.length ? `已删除 ${removed.length} 个重复模型` : '没有重复模型');
  } catch (e) {
    setStatus(`去重失败：${e.message}`);
  }
  dedupeBtn.disabled = false;
  await refreshModelList();
});

refreshModelList().then(() => {
  if (modelFiles.length) loadUrl(modelFiles[0].url, modelFiles[0].name);
});

const fileInput = document.getElementById('file-input');
document.getElementById('file-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });

const dropOverlay = document.getElementById('drop-overlay');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropOverlay.classList.add('visible'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.remove('visible'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('visible');
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- render loop
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

