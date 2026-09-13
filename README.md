# 图片 → Gaussian Splat → Three.js 查看器

单张图片用 [TripoSplat](https://github.com/VAST-AI-Research/TripoSplat)（本地 Apple Silicon MPS 推理）生成 3D 高斯，再用 three.js r186 原生 `GaussianSplat` + `WebGPURenderer` 在浏览器中查看。也支持查看任意 .spz / .ply / .splat / .ksplat 文件。

## 快速开始

```bash
npm install && npm run dev   # http://localhost:5180（需 WebGPU 浏览器）
```

仓库里**不包含** TripoSplat 后端目录——首次打开网页时会检测到后端不可用，出现「初始化后端」按钮，点击后自动完成：`git clone` 上游仓库 → 创建 .venv 并安装依赖 → 下载 4.2GB 模型权重（要求本机有 git 和 python3）。

**各阶段预期耗时**（看着不动不是卡死，是在下载数据或 GPU 计算）：

| 阶段 | 预期耗时 | 说明 |
|---|---|---|
| 拉取仓库 | 几秒 | `git clone --depth 1` |
| 创建虚拟环境 | ~10 秒 | `python3 -m venv` |
| 安装依赖 | 2~5 分钟 | torch 约 2GB，视网速 |
| 下载模型权重 | 3~15 分钟 | 4.2GB，视网速，进度条实时显示 |
| 首次转换（32k） | 约 8 分钟 | 模型加载 ~30 秒 + 采样 20 步 × ~21 秒/步（M1 Pro 实测）|

转换过程中大部分时间处于「采样中 (GPU)」，进度条按采样步数推进；如果进度长时间停住，先用活动监视器确认 `python run_local.py` 的 CPU/GPU 占用——正常计算时占用不为零。也可手动准备后端：

```bash
cd TripoSplat
python3 -m venv .venv
.venv/bin/pip install torch torchvision numpy safetensors pillow tqdm huggingface_hub
.venv/bin/hf download VAST-AI/TripoSplat --local-dir ckpts/
```

## 网页功能

- **模型列表**：动态列出 `public/models/` 下所有 .spz / .ply / .splat / .ksplat 文件（按修改时间倒序，最新的在最前并默认加载）；往目录里放新模型文件或完成一次转换，按钮列表都会自动更新
- **模型管理**：每个模型可重命名、删除；基于内容 MD5 识别重复文件（标「重复」角标），支持一键去重（保留最早的一份）
- **后端初始化**：检测到后端不可用时一键拉取 TripoSplat 仓库、创建虚拟环境并下载模型权重，进度实时显示，可中断
- **图片转 3D**：拖入或选择图片 → 检测本地 TripoSplat 后端 → 弹窗确认（可选 Gaussian 数量 32k~262k）→ 后台 MPS 推理 → 进度条实时显示 → 完成自动加载
- **白底自动移除**：上传白底图片时在浏览器端自动检测并抠成透明背景（从四边泛洪填充，保留主体内部的白色高光），再送入转换
- **任务管理**：转换中可点「中断生成任务」停止；刷新页面后自动恢复任务进度
- **模型下载**：当前展示的 URL 加载的模型（示例 / 生成结果）可一键下载两个文件：3D 文件本体 + 内嵌模型数据的独立预览 HTML（双击即可在浏览器查看，需联网加载 three.js CDN）；本地拖入的文件不提供下载

- **查看器**：TrackballControls 自由旋转——绕 X / Y 轴（及其他任意轴）均可无限 360° 翻转，无极点死区；左键旋转、滚轮缩放、右键平移

## 关于 MPS 的结论

MPS 直接可用，不需要换 torch 版本，也不存在 Metal 兼容问题。逐项排查的依据：

- 逐张量把权重拷到 MPS：0.7 秒完成（712MB 主模型）
- 5 个模型权重全部加载完成：仅 14 秒
- 之前看起来「卡死」，其实是**采样阶段在 GPU 上正常计算**（约 21 秒/步 × 20 步，32k gaussians 全程约 8 分钟），而进度输出被 `| head` 管道缓冲了，看起来像挂起

注意事项：MPS 上运行时不要用管道吞输出（`| head` 等）；16GB 内存的机器建议先用 32k/64k 档位。

## 项目结构

```
index.html                  网页 UI（模型切换、转换弹窗）
src/main.js                 three.js 查看器 + 转换/下载/中断逻辑
vite-plugin-triposplat.js   Vite 中间件：/api/triposplat/*（状态/初始化/转换/进度/中断）
TripoSplat/                 上游推理仓库（MIT，网页初始化时自动拉取）
run_local.py                本地推理脚本（根目录，自动适配 TripoSplat 子目录；设备自动检测 mps→cuda→cpu）
public/models/              示例与生成产物（生成的文件会被 .gitignore 忽略）
```

## 前端实现要点（three.js r186）

- 必须用 `WebGPURenderer`（splat 深度排序基于 TSL compute shader）
- 核心三步：loader → `new GaussianSplat(geometry)` → `scene.add()`
- 加载器：`SPZLoader` / `GaussianSplatPLYLoader` / `SPLATLoader` / `KSPLATLoader`，按扩展名自动选择
- TripoSplat 导出的 PLY 为 Y 朝下约定，加载时绕 X 轴旋转 180° 翻正
