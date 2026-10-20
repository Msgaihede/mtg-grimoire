"""Train the Quickdraw-shaped embedder (qd_model.py) on camera-simulated views of every look.

    python qd_train.py <dataset dir> <run dir> [--epochs 30] [--batch 256] [--workers N] [--prefetch 2]

One class per look (looks.py); each epoch shows every look once, as a degraded query view of a
random member printing (qd_data.py). ArcFace over all ~70k looks gives every step the whole
catalogue as negatives, look-alikes included — the hard examples an in-batch contrastive loss
sees too rarely (oracle's recipe saturated at loss ~0.003 and left its MobileNetV4 at 0.998
|cos| from ImageNet). Learning rates are set so the backbone actually moves. The class weights
start at each look's reference-crop embedding (`prototype_init`).

Throughput on Windows (measured 2026-10-19): views travel from the workers as uint8 and are
normalised on the GPU, the 20 workers persist across epochs, and loss and accuracy are summed on
the GPU — the first version, float batches through shared memory, workers respawned every epoch
and two syncs a step, ran at ~300 views/s with the CPU at 15 % and the GPU at 30 %.

Every `--eval-every` epochs: retrieval top-1 of fixed query views of 3 000 looks against those
looks' reference prototypes (mean of their members' reference embeddings) — the scanner's own
question, not the classifier's. Logs one JSON line per epoch to <run dir>/log.jsonl; checkpoints
last.pt and best.pt (by retrieval top-1), each with its ArcFace class weights (`.head.pt`).

Resumable (runs.py): every epoch ends with `checkpoint.pt`; started again with the same arguments
the run goes on from the last finished epoch, and a finished run only prints its final line,
`{"done": true, ...}` — the last epoch's numbers, the best retrieval top-1 and the mean views/s.
"""
import argparse
import json
import math
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from qd_data import Looks, ReferenceViews, TrainViews, camera_view, load, normalize
from qd_model import ArcFace, Embedder
from runs import (CHECKPOINT, atomic_save, check_recipe, clear_partials, default_workers, file_sha256,
                  load_checkpoint, reconcile_log, rng_state, set_rng_state)

# The arguments a checkpoint must have been made with to be resumed.
RECIPE = ("epochs", "batch", "lr", "head_lr", "margin", "warmup", "eval_every", "eval_looks", "seed")


def fixed_queries(looks: Looks, picks: list[int], seed: int) -> torch.Tensor:
    out = []
    for n, i in enumerate(picks):
        rng = random.Random(seed * 7919 + n)
        look = looks.looks[i]
        out.append(camera_view(load(looks.path(rng.choice(look["members"])), reduced=True), rng))
    return torch.from_numpy(np.stack(out))


def embed(model, x: torch.Tensor, device) -> torch.Tensor:
    with torch.autocast("cuda", dtype=torch.bfloat16):
        return model(normalize(x.to(device, non_blocking=True))).float()


@torch.no_grad()
def prototype_init(model, head, looks, device, workers, prefetch) -> None:
    """Start every look's ArcFace weight at its reference crop's embedding, so the classifier
    begins at the gallery instead of at random: with one view per look per epoch, a random
    70k-way head learns too slowly (epoch 1 of the first run: train accuracy 0.0)."""
    model.eval()
    for x, idx in DataLoader(ReferenceViews(looks, reps_only=True), batch_size=512, num_workers=workers, prefetch_factor=prefetch):
        head.weight.data[idx.to(device)] = embed(model, x, device)
    model.train()


@torch.no_grad()
def retrieval_top1(model, looks, picks, queries, device, workers, prefetch) -> float:
    model.eval()
    sub = Looks.__new__(Looks)
    sub.root, sub.looks, sub.layout = looks.root, [looks.looks[i] for i in picks], looks.layout
    protos = torch.zeros(len(picks), 128, device=device)
    for x, idx in DataLoader(ReferenceViews(sub), batch_size=256, num_workers=workers, prefetch_factor=prefetch):
        protos.index_add_(0, idx.to(device), embed(model, x, device))
    protos = F.normalize(protos, dim=1)
    hits = 0
    for k in range(0, len(queries), 256):
        q = embed(model, queries[k : k + 256], device)
        hits += (q @ protos.t()).argmax(1).eq(torch.arange(k, k + len(q), device=device)).sum().item()
    model.train()
    return hits / len(queries)


def done_row(rows: list[dict], best: float, epochs: int) -> dict:
    """The run's final line: the last epoch's numbers (last.pt is what the pipeline exports), the
    best retrieval top-1, and views/s over every epoch."""
    last = rows[-1]
    seconds = sum(r["seconds"] for r in rows)
    return {"done": True, "epoch": last["epoch"], "epochs": epochs, "step": last["step"], "loss": last["loss"],
            "train_acc": last["train_acc"], "retrieval_top1": last.get("retrieval_top1"), "best_retrieval_top1": best,
            "seconds": round(seconds, 1), "views_per_s": round(sum(r["views_per_s"] * r["seconds"] for r in rows) / max(seconds, 1e-9))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("run")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--workers", type=int, default=default_workers(), help="data workers (default: every core but two)")
    ap.add_argument("--prefetch", type=int, default=2, help="batches each data worker keeps ready, in shared memory")
    ap.add_argument("--lr", type=float, default=2e-3, help="backbone peak learning rate")
    ap.add_argument("--head-lr", type=float, default=1e-2, help="projection and ArcFace class weights")
    ap.add_argument("--margin", type=float, default=0.3)
    ap.add_argument("--warmup", type=int, default=500, help="steps")
    ap.add_argument("--eval-every", type=int, default=3)
    ap.add_argument("--eval-looks", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    run = Path(args.run)
    run.mkdir(parents=True, exist_ok=True)
    clear_partials(run)
    ckpt = load_checkpoint(run)
    if ckpt is not None:
        check_recipe(ckpt, args, RECIPE, run)
        if ckpt["epoch"] >= args.epochs:
            done = done_row(ckpt["rows"], ckpt["best"], args.epochs)
            reconcile_log(run / "log.jsonl", ckpt["rows"], "epoch", done)
            print(f"{run / CHECKPOINT}: all {args.epochs} epochs done", flush=True)
            print(json.dumps(done), flush=True)
            return
    torch.manual_seed(args.seed)
    device = torch.device("cuda")
    torch.backends.cudnn.benchmark = True

    looks = Looks(Path(args.data))
    n = len(looks.looks)
    looks_sha = file_sha256(Path(args.data) / "looks.json")
    if ckpt is not None and ckpt["looks_sha256"] != looks_sha:
        raise SystemExit(f"{run / CHECKPOINT} was trained on another looks.json ({ckpt['looks']} looks): its class "
                         "weights do not fit this one's; start a new run directory")
    model = Embedder(pretrained=ckpt is None).to(device)
    head = ArcFace(n, margin=args.margin).to(device)
    started = time.time()
    if ckpt is None:
        prototype_init(model, head, looks, device, args.workers, args.prefetch)
        print(f"ArcFace weights from {n} reference crops in {time.time() - started:.0f} s", flush=True)
    else:
        model.load_state_dict(ckpt["model"])
        head.load_state_dict(ckpt["head"])
        print(f"resumed {run / CHECKPOINT} after epoch {ckpt['epoch']} of {args.epochs} (step {ckpt['step']})", flush=True)
    opt = torch.optim.AdamW(
        [
            {"params": model.body.parameters(), "lr": args.lr, "weight_decay": 1e-5},
            {"params": model.head.parameters(), "lr": args.head_lr, "weight_decay": 1e-4},
            {"params": head.parameters(), "lr": args.head_lr, "weight_decay": 0.0},
        ]
    )
    steps_per_epoch = n // args.batch
    total = steps_per_epoch * args.epochs
    base = [g["lr"] for g in opt.param_groups]  # the peaks, before a checkpoint's scheduled values replace them
    if ckpt is not None:
        opt.load_state_dict(ckpt["optimizer"])

    def set_lr(step):
        f = step / args.warmup if step < args.warmup else 0.5 * (1 + math.cos(math.pi * (step - args.warmup) / max(1, total - args.warmup)))
        for g, b in zip(opt.param_groups, base):
            g["lr"] = b * max(f, 0.01)

    picks = random.Random(args.seed + 1).sample(range(n), min(args.eval_looks, n))
    queries = fixed_queries(looks, picks, args.seed + 2)
    best, step, first, rows = -1.0, 0, 0, []
    if ckpt is None:
        meta = {"looks": n, "faces": sum(len(l["members"]) for l in looks.looks), "looks_sha256": looks_sha,
                "args": vars(args), "torch": torch.__version__}
        (run / "run.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
        print(json.dumps({"epoch": 0, "retrieval_top1": retrieval_top1(model, looks, picks, queries, device, args.workers, args.prefetch)}), flush=True)
    else:
        best, step, first, rows = ckpt["best"], ckpt["step"], ckpt["epoch"], ckpt["rows"]
        reconcile_log(run / "log.jsonl", rows, "epoch")
    log = open(run / "log.jsonl", "a", encoding="utf-8")
    loader = DataLoader(
        TrainViews(looks), batch_size=args.batch, shuffle=True, num_workers=args.workers, pin_memory=True,
        drop_last=True, persistent_workers=True, prefetch_factor=args.prefetch,
    )
    if ckpt is not None:
        set_rng_state(ckpt["rng"])
        del ckpt
    for epoch in range(first, args.epochs):
        started = time.time()
        loss_sum = torch.zeros((), device=device)
        hit_sum = torch.zeros((), device=device)
        seen = 0
        for x, y in loader:
            set_lr(step)
            y = y.to(device, non_blocking=True)
            loss, cos = head(embed(model, x, device), y)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            step += 1
            loss_sum += loss.detach() * len(y)
            hit_sum += cos.detach().argmax(1).eq(y).sum()
            seen += len(y)
        row = {"epoch": epoch + 1, "loss": loss_sum.item() / seen, "train_acc": hit_sum.item() / seen,
               "seconds": round(time.time() - started, 1), "views_per_s": round(seen / (time.time() - started)), "step": step}
        if (epoch + 1) % args.eval_every == 0 or epoch + 1 == args.epochs:
            row["retrieval_top1"] = retrieval_top1(model, looks, picks, queries, device, min(args.workers, 8), args.prefetch)
        state = {k: v.detach().cpu() for k, v in model.state_dict().items()}
        # The class weights too: one learned prototype per look, trained against camera views,
        # which qd_export.py can use as the gallery instead of (or with) clean-scan averages.
        weights = head.weight.detach().float().cpu()
        atomic_save(state, run / "last.pt")
        atomic_save(weights, run / "last.head.pt")
        if row.get("retrieval_top1", -1) > best:
            best = row["retrieval_top1"]
            atomic_save(state, run / "best.pt")
            atomic_save(weights, run / "best.head.pt")
        rows.append(row)
        # Last, the point a restart goes on from: everything above is already on disk.
        atomic_save({
            "model": state, "head": {"weight": weights}, "optimizer": opt.state_dict(), "step": step, "epoch": epoch + 1,
            "best": best, "rows": rows, "rng": rng_state(), "args": vars(args), "looks": n, "looks_sha256": looks_sha,
            "torch": str(torch.__version__),  # a plain str: weights_only loading refuses TorchVersion
        }, run / CHECKPOINT)
        print(json.dumps(row), flush=True)
        log.write(json.dumps(row) + "\n")
        log.flush()
    done = done_row(rows, best, args.epochs)
    print(json.dumps(done), flush=True)
    log.write(json.dumps(done) + "\n")
    log.flush()


if __name__ == "__main__":
    main()
