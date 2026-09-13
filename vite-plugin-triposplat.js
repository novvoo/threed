// Vite 开发服务器插件：把图片交给本地 TripoSplat (MPS) 转成 Gaussian Splat
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const TSPLAT_DIR = path.resolve(process.cwd(), 'TripoSplat');
const PYTHON = path.join(TSPLAT_DIR, '.venv', 'bin', 'python');
const CKPTS = path.join(TSPLAT_DIR, 'ckpts');
const PUBLIC_MODELS = path.resolve(process.cwd(), 'public', 'models');
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

// 质量优先的默认参数：Gaussian 拉满 + 更多采样步数（换取更好细节，单次转换约 12~15 分钟）
const NUM_GAUSSIANS = 262144;
const STEPS = 30;
const MODEL_RE = /\.(spz|ply|splat|ksplat)$/i;

const PIP_PKGS = 'torch torchvision numpy safetensors pillow tqdm huggingface_hub';
const CONFIG_PATH = path.resolve(process.cwd(), 'triposplat.config.json');
const DEFAULT_CONFIG = {
  repo: 'https://github.com/VAST-AI-Research/TripoSplat.git', // 生成器代码仓库（git clone）
  model: 'VAST-AI/TripoSplat',                                // HuggingFace 模型权重 ID
};
function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

// run_local.py 固定在项目根目录（已提交），自动适配 TripoSplat 子目录的路径与设备
const RUN_LOCAL_PATH = path.resolve(process.cwd(), 'run_local.py');


// job: { id, status: 'running'|'done'|'error', progress, stage, error?, plyUrl?, splatUrl? }
const jobs = new Map();

function repoCloned() {
  return fs.existsSync(path.join(TSPLAT_DIR, 'model.py'));
}
function venvReady() {
  return fs.existsSync(PYTHON);
}
function modelReady() {
  return fs.existsSync(path.join(CKPTS, 'diffusion_models/triposplat_fp16.safetensors'));
}

function backendAvailable() {
  return venvReady() && modelReady();
}

// ---------------------------------------------------------------- 一键初始化（拉取仓库 / 建 venv / 下载权重）
// setup: { status: 'idle'|'running'|'done'|'error', stage, progress, error?, step?, cancel? }
const setup = { status: 'idle', stage: '', progress: 0, error: null };

function runProc(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, opts);
    setup.cancel = () => proc.kill('SIGTERM');
    const onErr = (buf) => { setup.log = (setup.log || '') + buf.toString(); };
    proc.stdout?.on('data', onErr);
    proc.stderr.on('data', onErr);
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))));
  });
}

function parseDownloadProgress() {
  // hf download 的合并进度条："Fetching 5 files:  40%|████ |"
  const m = [...(setup.log || '').matchAll(/Fetching (\d+) files:\s*(\d+)%/g)].pop();
  if (m) {
    setup.stage = `下载模型权重 ${m[2]}%（共 ${m[1]} 个文件，约 4.2GB）`;
    setup.progress = 20 + Number(m[2]) * 0.8;
    return;
  }
  // 单文件进度条作为兜底："xxx.safetensors:  12%|"
  const f = [...(setup.log || '').matchAll(/(downloading|safetensors[^\s:]*):\s*(\d+)%/gi)].pop();
  if (f) {
    setup.stage = `下载模型权重 ${f[2]}%（约 4.2GB）`;
    setup.progress = 20 + Number(f[2]) * 0.8;
  }
}

async function runSetup(config) {
  if (setup.status === 'running') return;
  setup.config = config || loadConfig();
  setup.status = 'running';
  setup.error = null;
  setup.log = '';
  try {
    if (!repoCloned()) {
      setup.stage = '拉取 TripoSplat 仓库 (git clone)';
      setup.progress = 2;
      await runProc('git', ['clone', '--depth', '1', setup.config.repo, TSPLAT_DIR], { cwd: process.cwd() });
    }
    if (!venvReady()) {
      setup.stage = '创建 Python 虚拟环境 (.venv)';
      setup.progress = 8;
      await runProc('python3', ['-m', 'venv', '.venv'], { cwd: TSPLAT_DIR });
      setup.stage = '安装依赖 (torch 等，首次较慢)';
      setup.progress = 12;
      await runProc(path.join('.venv', 'bin', 'pip'), ['install', '--quiet', ...PIP_PKGS.split(' ')], { cwd: TSPLAT_DIR });
    }
    if (!modelReady()) {
      setup.stage = '下载模型权重（约 4.2GB）';
      setup.progress = 20;
      await runProc(path.join('.venv', 'bin', 'hf'), ['download', setup.config.model, '--local-dir', 'ckpts'], { cwd: TSPLAT_DIR });
      parseDownloadProgress();
    }
    setup.stage = '完成';
    setup.progress = 100;
    setup.status = 'done';
  } catch (e) {
    setup.status = setup.cancelled ? 'idle' : 'error';
    setup.error = setup.cancelled ? null : `${e.message}，详见终端输出`;
    setup.cancelled = false;
    if (setup.status === 'idle') setup.stage = '已中断';
  } finally {
    setup.cancel = null;
  }
}

function parseProgress(text) {
  // tqdm 输出形如 "Sampling:  45%|████▍ | 9/20 [03:24<03:27, 20.74s/it]"
  const m = [...text.matchAll(/Sampling:\s*(\d+)%/g)].pop();
  if (m) return { stage: '采样中 (GPU)', progress: 5 + Number(m[1]) * 0.9 };
  if (/STAGE: preprocess|load/.test(text)) return { stage: '加载模型 / 预处理', progress: 3 };
  if (/STAGE: encode/.test(text)) return { stage: '编码图片', progress: 4 };
  if (/STAGE: decode/.test(text)) return { stage: '解码 Gaussians', progress: 97 };
  return null;
}

function startJob(imagePath, numGaussians) {
  const id = `job_${Date.now()}`;
  const outName = `generated_${id}`;
  const job = { id, status: 'running', progress: 0, stage: '排队中', log: '', outName };
  jobs.set(id, job);

  const proc = spawn(PYTHON, ['-u', RUN_LOCAL_PATH, imagePath, String(numGaussians), outName, String(STEPS)], {
    cwd: process.cwd(),
  });
  job.pid = proc.pid;
  job.cancel = () => { proc.kill('SIGTERM'); };

  const onData = (buf) => {
    job.log += buf.toString();
    if (job.log.length > 64 * 1024) job.log = job.log.slice(-32 * 1024);
    const p = parseProgress(job.log);
    if (p) { job.stage = p.stage; job.progress = p.progress; }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code) => {
    if (job.status === 'cancelled') {
      // 中断后清理半成品输出（脚本在项目根目录运行，输出落在根目录）
      for (const ext of ['ply', 'splat']) {
        fs.rm(path.join(process.cwd(), `${outName}.${ext}`), { force: true }, () => {});
      }
      return;
    }
    if (code === 0) {
      try {
        fs.mkdirSync(PUBLIC_MODELS, { recursive: true });
        fs.copyFileSync(path.join(process.cwd(), `${outName}.ply`), path.join(PUBLIC_MODELS, `${outName}.ply`));
        fs.copyFileSync(path.join(process.cwd(), `${outName}.splat`), path.join(PUBLIC_MODELS, `${outName}.splat`));
        job.status = 'done';
        job.progress = 100;
        job.plyUrl = `/models/${outName}.ply`;
      } catch (e) {
        job.status = 'error';
        job.error = e.message;
      }
    } else {
      job.status = 'error';
      job.error = `推理进程退出码 ${code}，详见终端输出`;
    }
  });
  return job;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- 模型列表 / 重命名 / 删除 / 去重
// hash 按文件缓存，size+mtime 未变时直接复用
const hashCache = new Map();

function fileHash(filePath) {
  const st = fs.statSync(filePath);
  const key = filePath;
  const cached = hashCache.get(key);
  if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) return cached.hash;
  const hash = crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
  hashCache.set(key, { size: st.size, mtime: st.mtimeMs, hash });
  return hash;
}

function listModels() {
  if (!fs.existsSync(PUBLIC_MODELS)) return [];
  const files = fs.readdirSync(PUBLIC_MODELS)
    .filter((f) => MODEL_RE.test(f))
    .map((f) => {
      const p = path.join(PUBLIC_MODELS, f);
      try {
        const st = fs.statSync(p);
        return { name: f, url: `/models/${f}`, size: st.size, mtime: st.mtimeMs, hash: fileHash(p) };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  // 同 hash 标记重复：保留最早的一份，其余标 dup
  const seen = new Set();
  for (let i = files.length - 1; i >= 0; i--) {
    if (seen.has(files[i].hash)) files[i].dup = true;
    else seen.add(files[i].hash);
  }
  return files;
}

function safeModelName(name) {
  const base = path.basename(String(name || ''));
  if (!MODEL_RE.test(base)) return null;
  return base;
}

export function tripoSplatPlugin() {
  return {
    name: 'triposplat-backend',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url.split('?')[0];

        if (url === '/api/triposplat/status') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            available: backendAvailable(),
            repo: repoCloned(), venv: venvReady(), model: modelReady(),
            config: loadConfig(),
            setup: { status: setup.status, stage: setup.stage, progress: Math.round(setup.progress), error: setup.error },
          }));
          return;
        }

        // 初始化配置读取/保存；POST 带 JSON 体 { repo, model } 时先持久化再启动
        if (url === '/api/triposplat/setup' && req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(loadConfig()));
          return;
        }

        // 一键初始化：拉取仓库 → 建 venv 装依赖 → hf 下载权重
        if (url === '/api/triposplat/setup' && req.method === 'POST') {
          if (!repoCloned() && process.platform !== 'darwin') {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: '需要 git 与 python3 环境' }));
            return;
          }
          const body = await readBody(req);
          let cfg = {};
          try { if (body.length) cfg = JSON.parse(body.toString()); } catch {}
          const config = loadConfig();
          if (cfg.repo) config.repo = String(cfg.repo).trim();
          if (cfg.model) config.model = String(cfg.model).trim();
          saveConfig(config);
          runSetup(config);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, config }));
          return;
        }
        if (url === '/api/triposplat/setup' && req.method === 'DELETE') {
          if (setup.status === 'running') {
            setup.cancelled = true;
            setup.cancel?.();
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (url === '/api/triposplat/convert' && req.method === 'POST') {
          if (!backendAvailable()) {
            res.statusCode = 503;
            res.end(JSON.stringify({ error: 'TripoSplat 后端不可用（缺少 .venv 或 ckpts）' }));
            return;
          }
          const running = [...jobs.values()].find((j) => j.status === 'running');
          if (running) {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: '已有转换任务在运行，请等待完成', jobId: running.id }));
            return;
          }
          const filename = decodeURIComponent(req.headers['x-filename'] || 'image.png');
          if (!IMAGE_RE.test(filename)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: `不支持的图片格式: ${filename}` }));
            return;
          }
          const num = Number(req.headers['x-num-gaussians'] || NUM_GAUSSIANS);
          const body = await readBody(req);
          const safeName = `input_${Date.now()}${path.extname(filename).toLowerCase()}`;
          fs.mkdirSync(path.join(TSPLAT_DIR, 'inputs'), { recursive: true });
          fs.writeFileSync(path.join(TSPLAT_DIR, 'inputs', safeName), body);
          const job = startJob(path.join(TSPLAT_DIR, 'inputs', safeName), num);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ jobId: job.id }));
          return;
        }

        const jobMatch = url.match(/^\/api\/triposplat\/job\/(.+)$/);
        if (jobMatch) {
          const id = jobMatch[1];
          if (req.method === 'DELETE') {
            const j = jobs.get(id);
            if (j && j.status === 'running') {
              j.status = 'cancelled';
              j.cancel?.();
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          const j = jobs.get(id);
          if (j) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              status: j.status, progress: Math.round(j.progress), stage: j.stage,
              error: j.error, plyUrl: j.plyUrl,
            }));
            return;
          }
        }

        // 列出 public/models 下已有的模型文件（按修改时间倒序，同内容标 dup）
        if (url === '/api/models') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(listModels()));
          return;
        }

        // 重命名模型：JSON {from, to}
        if (url === '/api/models/rename' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString() || '{}');
          const from = safeModelName(body.from);
          let to = safeModelName(body.to);
          if (!from || !to) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: '文件名必须是 .spz/.ply/.splat/.ksplat' }));
            return;
          }
          if (fs.existsSync(path.join(PUBLIC_MODELS, to))) {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: `已存在同名文件: ${to}` }));
            return;
          }
          fs.renameSync(path.join(PUBLIC_MODELS, from), path.join(PUBLIC_MODELS, to));
          const cachedHash = hashCache.get(path.join(PUBLIC_MODELS, from));
          hashCache.delete(path.join(PUBLIC_MODELS, from));
          if (cachedHash) hashCache.set(path.join(PUBLIC_MODELS, to), cachedHash);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // 删除模型：JSON {name}
        if (url === '/api/models/delete' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString() || '{}');
          const name = safeModelName(body.name);
          if (!name) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: '无效文件名' }));
            return;
          }
          fs.rmSync(path.join(PUBLIC_MODELS, name), { force: true });
          hashCache.delete(path.join(PUBLIC_MODELS, name));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // 一键去重：同 hash 的重复文件只保留最早的一份
        if (url === '/api/models/dedupe' && req.method === 'POST') {
          const dupes = listModels().filter((f) => f.dup).map((f) => f.name);
          for (const name of dupes) {
            fs.rmSync(path.join(PUBLIC_MODELS, name), { force: true });
            hashCache.delete(path.join(PUBLIC_MODELS, name));
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, removed: dupes }));
          return;
        }

        // 页面刷新后恢复任务状态
        if (url === '/api/triposplat/current') {
          const last = [...jobs.values()].pop() || null;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(last ? {
            jobId: last.id, status: last.status, progress: Math.round(last.progress),
            stage: last.stage, error: last.error, plyUrl: last.plyUrl,
          } : null));
          return;
        }

        next();
      });
    },
  };
}
