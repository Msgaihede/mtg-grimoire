"""Train the card detector (qd_detector.py) on synthetic scenes (qd_detect_data.py).

    python qd_detect_train.py <dataset dir> <run dir> [--steps 30000] [--batch 64] [--workers N] [--prefetch 2]

CenterNet's losses: a focal loss on the centre heat map (cells round a card too covered to judge
weighted out), L1 on the corners at the peak and its neighbours (weighted by the heat there), BCE
on upside-down at the same cells. AdamW, warm-up then cosine, bf16.

Every `--eval-every` steps, on a fixed set of scenes: the share of cards found (a detection over
0.5 whose centre is within a quarter of the card's height of the card's), their mean corner error
as a share of the card's height, which way up they came back, and the false detections per
scene. Logs one JSON line per evaluation to <run dir>/log.jsonl; checkpoints last.pt and best.pt
(by found share, then corner error).

Resumable (runs.py): every evaluation ends with `checkpoint.pt`; started again with the same
arguments the run goes on from the last evaluated step, and a finished run only prints its final
line, `{"done": true, ...}` — the last evaluation's numbers, the best, and the mean scenes/s.
"""
import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from qd_data import Looks, normalize
from qd_detect_data import Batches, Scenes, decode
from qd_detector import Detector
from runs import (CHECKPOINT, atomic_save, check_recipe, clear_partials, default_workers, load_checkpoint,
                  reconcile_log, rng_state, set_rng_state)

# The arguments a checkpoint must have been made with to be resumed.
RECIPE = ("steps", "batch", "lr", "warmup", "eval_every", "eval_batches", "corner_weight", "flip_weight")


def focal(logits: torch.Tensor, heat: torch.Tensor, weight: torch.Tensor) -> torch.Tensor:
    logits = logits.float()
    pos = heat.eq(1).float()
    neg = (1 - pos) * weight
    p = logits.sigmoid()
    pos_loss = -(F.logsigmoid(logits) * (1 - p) ** 2 * pos).sum()
    neg_loss = -(F.logsigmoid(-logits) * p**2 * (1 - heat) ** 4 * neg).sum()
    return (pos_loss + neg_loss) / pos.sum().clamp(min=1)


def losses(maps, heat, corners, flip, cw, hw):
    maps = maps.float()
    l_heat = focal(maps[:, 0], heat, hw)
    l_corner = ((maps[:, 1:9] - corners).abs() * cw[:, None]).sum() / cw.sum().clamp(min=1)
    l_flip = (F.binary_cross_entropy_with_logits(maps[:, 9], flip, reduction="none") * cw).sum() / cw.sum().clamp(min=1)
    return l_heat, l_corner, l_flip


@torch.no_grad()
def evaluate(model, scenes, device) -> dict:
    """Found share, corner error and orientation on fixed scenes, from the labelled cards
    re-derived from the targets (peak cells) — the same cards the loss saw."""
    model.eval()
    found = cards = wrong_way = fp = 0
    errors = []
    for image, heat, corners, flip, cw, hw in scenes:
        with torch.autocast("cuda", dtype=torch.bfloat16):
            maps = model(normalize(image.to(device))).float().cpu().numpy()
        for b in range(len(image)):
            dets = [d for d in decode(maps[b]) if d[0] >= 0.5]
            used = set()
            ys, xs = np.nonzero(heat[b].numpy() == 1)
            for y, x in zip(ys, xs):
                centre = np.float32([(x + 0.5) * 8, (y + 0.5) * 8])
                raw = corners[b, :, y, x].numpy().reshape(4, 2) * 64 + centre
                truth = raw[[2, 3, 0, 1]] if flip[b, y, x] > 0.5 else raw
                h = float(np.linalg.norm(truth[3] - truth[0]))
                cards += 1
                best = None
                for k, (s, q, f) in enumerate(dets):
                    d = float(np.linalg.norm(q.mean(0) - truth.mean(0)))
                    if k not in used and d < 0.25 * h and (best is None or d < best[0]):
                        best = (d, k, q)
                if best is None:
                    continue
                used.add(best[1])
                found += 1
                q = best[2]
                err = float(np.linalg.norm(q - truth, axis=1).mean())
                turned = float(np.linalg.norm(q[[2, 3, 0, 1]] - truth, axis=1).mean())
                wrong_way += turned < err
                errors.append(min(err, turned) / h)
            # A detection near no labelled card and no ignored one is a false one.
            hwb = hw[b].numpy()
            for k, (s, q, f) in enumerate(dets):
                if k in used:
                    continue
                cx, cy = (q.mean(0) / 8).astype(int)
                if 0 <= cy < hwb.shape[0] and 0 <= cx < hwb.shape[1] and hwb[cy, cx] == 0:
                    continue
                fp += 1
    model.train()
    return {
        "found": found / max(1, cards), "cards": cards,
        "corner_err": float(np.mean(errors)) if errors else None,
        "corner_err_p90": float(np.percentile(errors, 90)) if errors else None,
        "wrong_way": wrong_way / max(1, found), "fp": fp,
    }


def done_row(rows: list[dict], best: tuple, steps: int) -> dict:
    """The run's final line: the last evaluation's numbers (last.pt is what the pipeline
    exports), the best, and scenes/s over every interval between evaluations."""
    last = {k: v for k, v in rows[-1].items() if k != "scenes_per_s"}
    spans = [r["step"] - p for r, p in zip(rows, [0] + [r["step"] for r in rows[:-1]])]
    rate = sum(s / r["scenes_per_s"] for r, s in zip(rows, spans) if r["scenes_per_s"])
    return {"done": True, **last, "steps": steps, "best_found": best[0], "best_corner_err": -best[1],
            "scenes_per_s": round(sum(spans) / rate) if rate else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("run")
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--workers", type=int, default=default_workers(), help="data workers (default: every core but two)")
    ap.add_argument("--prefetch", type=int, default=2, help="batches each data worker keeps ready, in shared memory")
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--warmup", type=int, default=1000)
    ap.add_argument("--eval-every", type=int, default=2500)
    ap.add_argument("--eval-batches", type=int, default=24)
    ap.add_argument("--corner-weight", type=float, default=1.0)
    ap.add_argument("--flip-weight", type=float, default=0.5)
    args = ap.parse_args()
    run = Path(args.run)
    run.mkdir(parents=True, exist_ok=True)
    clear_partials(run)
    ckpt = load_checkpoint(run)
    if ckpt is not None:
        check_recipe(ckpt, args, RECIPE, run)
        if ckpt["step"] >= args.steps:
            done = done_row(ckpt["rows"], tuple(ckpt["best"]), args.steps)
            reconcile_log(run / "log.jsonl", ckpt["rows"], "step", done)
            print(f"{run / CHECKPOINT}: all {args.steps} steps done", flush=True)
            print(json.dumps(done), flush=True)
            return
    device = torch.device("cuda")
    torch.backends.cudnn.benchmark = True
    looks = Looks(Path(args.data))
    if ckpt is None:
        (run / "run.json").write_text(json.dumps({"args": vars(args), "torch": torch.__version__}, indent=1), encoding="utf-8")

    model = Detector(pretrained=ckpt is None).to(device)
    body = list(model.body.parameters())
    rest = [p for n, p in model.named_parameters() if not n.startswith("body.")]
    opt = torch.optim.AdamW([{"params": body, "lr": args.lr * 0.5}, {"params": rest, "lr": args.lr}], weight_decay=1e-4)
    base = [g["lr"] for g in opt.param_groups]  # the peaks, before a checkpoint's scheduled values replace them
    first, best, rows = 0, (-1.0, 1.0), []
    if ckpt is not None:
        model.load_state_dict(ckpt["model"])
        opt.load_state_dict(ckpt["optimizer"])
        first, best, rows = ckpt["step"], tuple(ckpt["best"]), ckpt["rows"]
        reconcile_log(run / "log.jsonl", rows, "step")
        print(f"resumed {run / CHECKPOINT} at step {first} of {args.steps}", flush=True)

    def set_lr(step):
        f = step / args.warmup if step < args.warmup else 0.5 * (1 + math.cos(math.pi * (step - args.warmup) / max(1, args.steps - args.warmup)))
        for g, b in zip(opt.param_groups, base):
            g["lr"] = b * max(f, 0.01)

    val = DataLoader(Scenes(looks, fixed=True), batch_sampler=Batches(args.eval_batches, 32, seed=7),
                     num_workers=min(args.workers, 8), persistent_workers=True, prefetch_factor=args.prefetch)
    train = DataLoader(Scenes(looks), batch_sampler=Batches(args.steps - first, args.batch), num_workers=args.workers,
                       pin_memory=True, prefetch_factor=args.prefetch)
    if ckpt is not None:
        set_rng_state(ckpt["rng"])
        del ckpt
    log = open(run / "log.jsonl", "a", encoding="utf-8")
    sums = torch.zeros(3, device=device)
    seen, started = 0, time.time()
    for step, (image, heat, corners, flip, cw, hw) in enumerate(train, first + 1):
        set_lr(step)
        heat, corners, flip, cw, hw = (t.to(device, non_blocking=True) for t in (heat, corners, flip, cw, hw))
        with torch.autocast("cuda", dtype=torch.bfloat16):
            maps = model(normalize(image.to(device, non_blocking=True)))
        l_heat, l_corner, l_flip = losses(maps, heat, corners, flip, cw, hw)
        loss = l_heat + args.corner_weight * l_corner + args.flip_weight * l_flip
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        sums += torch.stack([l_heat.detach(), l_corner.detach(), l_flip.detach()])
        seen += 1
        if step % args.eval_every == 0 or step == args.steps:
            s = (sums / seen).tolist()
            row = {"step": step, "heat": s[0], "corner": s[1], "flip": s[2],
                   "scenes_per_s": round(seen * args.batch / (time.time() - started))}
            row.update(evaluate(model, val, device))
            state = {k: v.detach().cpu() for k, v in model.state_dict().items()}
            atomic_save(state, run / "last.pt")
            key = (row["found"], -(row["corner_err"] or 1.0))
            if key > best:
                best = key
                atomic_save(state, run / "best.pt")
            rows.append(row)
            # Last, the point a restart goes on from: everything above is already on disk.
            atomic_save({
                "model": state, "optimizer": opt.state_dict(), "step": step, "best": list(best), "rows": rows,
                "rng": rng_state(), "args": vars(args), "torch": str(torch.__version__),  # weights_only refuses TorchVersion
            }, run / CHECKPOINT)
            print(json.dumps(row), flush=True)
            log.write(json.dumps(row) + "\n")
            log.flush()
            sums.zero_()
            seen, started = 0, time.time()
    done = done_row(rows, best, args.steps)
    print(json.dumps(done), flush=True)
    log.write(json.dumps(done) + "\n")
    log.flush()


if __name__ == "__main__":
    main()
