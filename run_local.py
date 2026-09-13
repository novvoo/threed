"""Local inference: image -> PLY + SPLAT. Usage: python run_local.py <image> [num_gaussians] [out] [steps]"""
import os, sys
import torch
ROOT = os.path.dirname(os.path.abspath(__file__))
TS = os.path.join(ROOT, "TripoSplat")
sys.path.insert(0, TS)
from triposplat import TripoSplatPipeline

IMAGE = sys.argv[1] if len(sys.argv) > 1 else "TripoSplat/static/example_inputs/building_stone_house.webp"
NUM = int(sys.argv[2]) if len(sys.argv) > 2 else 131072
OUT = sys.argv[3] if len(sys.argv) > 3 else "output"
STEPS = int(sys.argv[4]) if len(sys.argv) > 4 else 20
device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
print("device:", device, flush=True)

pipe = TripoSplatPipeline(
    ckpt_path              = os.path.join(TS, "ckpts/diffusion_models/triposplat_fp16.safetensors"),
    decoder_path           = os.path.join(TS, "ckpts/vae/triposplat_vae_decoder_fp16.safetensors"),
    dinov3_path            = os.path.join(TS, "ckpts/clip_vision/dino_v3_vit_h.safetensors"),
    flux2_vae_encoder_path = os.path.join(TS, "ckpts/vae/flux2-vae.safetensors"),
    rmbg_path              = os.path.join(TS, "ckpts/background_removal/birefnet.safetensors"),
    device                 = device,
)
print("STAGE: preprocess", flush=True)
gaussian, prepared = pipe.run(IMAGE, num_gaussians=NUM, steps=STEPS, show_progress=True)
print("STAGE: decode", flush=True)
gaussian.save_ply(OUT + ".ply")
gaussian.save_splat(OUT + ".splat")
print("done: " + OUT + ".ply / " + OUT + ".splat (" + str(NUM) + " gaussians)", flush=True)
