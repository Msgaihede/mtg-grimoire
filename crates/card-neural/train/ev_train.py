"""Train one printing-evidence network — the set symbol's or the collector band's (ev_data.py).

    python ev_train.py <dataset dir> <run dir> --kind symbol|band [--epochs N] [--repeats N]
        [--batch 256] [--workers N] [--prefetch 2] [--limit N]

The network is the embedder's recipe made small: an ImageNet-pretrained timm
`mobilenetv3_small_075`'s convolutional body (its 1 024-wide `conv_head` dropped: 443k of its 1.0M
weights, and the ONNX file under 3 MB without it), a 1×1 convolution to 64 channels, the small
feature map flattened — so where on the crop a mark sits still counts, as it does for a band's
layout — and `Linear(→ dim)`, L2-normalised: `crops [n,3,h,w] → embedding [n,dim]`, the names
`card_neural::Embedder::load` looks up.

Loss: ArcFace over the classes (qd_model.ArcFace, margin 0.3, scale 30), class weights started
at each class's reference crops' mean embedding (`prototypes`), as the embedder's.

Every `--eval-every` epochs, and at the end: the scanner's own question — for fixed camera crops
of printings of cards with two or more classes among their printings, is the true class the best
of that card's classes (prototypes: the mean of up to `PROTO_CAP` members' reference crops)?
That is `within_top1`; `best.pt` is the best by it, and the pipeline exports `best.pt`, as the
shipped files were.

**Epochs are the budget's, not the shipped runs'** (`KINDS`): the shipped `symbol.onnx` trained 16
epochs and `band.onnx` 20, ~75 and ~82 minutes on the owner's machine, which with the embedder
and the detector would not fit the owner's ~$9 a run on Modal (`train/README.md`, "The budget").
Their logs put within-card top-1 at its best by then: the symbol run's 0.927 at epoch 12 of 16,
the band run's 0.945 at epoch 14 of 20 (0.946 at 20). Every other default is the shipped runs'.

Resumable (runs.py): every epoch ends with `checkpoint.pt`; started again with the same arguments
the run goes on from the last finished epoch, and a finished run only prints its final line,
`{"done": true, ...}` — the last epoch's numbers, the best within-card top-1 and the mean views/s.
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
from torch import nn
from torch.utils.data import DataLoader

from ev_data import REGIONS, VIEW, Classes, ReferenceCrops, Region, TrainViews, camera_crop
from qd_data import load, normalize
from qd_model import ArcFace
from runs import CHECKPOINT, atomic_save, check_recipe, clear_partials, default_workers, load_checkpoint, reconcile_log, rng_state, set_rng_state

BACKBONE = "mobilenetv3_small_075.lamb_in1k"
DIM = 64
REDUCE = 64
PROTO_CAP = 8
# Per network: epochs (cut for the budget, above) and views of each class an epoch. A symbol
# class holds a set's every printing at one rarity, so it is shown 64 times an epoch; a band class
# is one printing face.
KINDS = {"symbol": {"epochs": 12, "repeats": 64}, "band": {"epochs": 14, "repeats": 1}}
# The arguments a checkpoint must have been made with to be resumed.
RECIPE = ("kind", "epochs", "repeats", "batch", "lr", "head_lr", "margin", "dim", "warmup", "eval_every", "eval_cards",
          "limit", "seed")


class CropEmbedder(nn.Module):
    """A crop of `region` → a unit fingerprint of `dim`."""

    def __init__(self, region: Region, dim: int = DIM, pretrained: bool = True):
        super().__init__()
        import timm

        self.body = timm.create_model(BACKBONE, pretrained=pretrained, num_classes=0)
        self.body.conv_head = nn.Identity()  # forward_features stops before it; drop its weights
        with torch.no_grad():
            c, fh, fw = self.body.eval().forward_features(torch.zeros(1, 3, region.height, region.width)).shape[1:]
        self.body.train()
        self.reduce = nn.Sequential(nn.Conv2d(c, REDUCE, 1, bias=False), nn.BatchNorm2d(REDUCE), nn.Hardswish())
        self.head = nn.Linear(REDUCE * fh * fw, dim)
        self.dim = dim

    def forward(self, crops: torch.Tensor) -> torch.Tensor:
        x = self.reduce(self.body.forward_features(crops))
        return F.normalize(self.head(x.flatten(1)), dim=1, eps=1e-6)


def embed(model, x: torch.Tensor, device) -> torch.Tensor:
    with torch.autocast("cuda", dtype=torch.bfloat16):
        return model(normalize(x.to(device, non_blocking=True))).float()


def loader_options(workers: int, prefetch: int) -> dict:
    return {"num_workers": workers, "prefetch_factor": prefetch} if workers > 0 else {"num_workers": 0}


@torch.no_grad()
def prototypes(model, classes, region, picks, device, workers, prefetch, cap=PROTO_CAP) -> torch.Tensor:
    """L2-normalised mean reference embedding of each class in `picks` (rows in `picks` order),
    from up to `cap` members."""
    was = model.training
    model.eval()
    where = {c: k for k, c in enumerate(picks)}
    out = torch.zeros(len(picks), model.dim, device=device)
    for x, c in DataLoader(ReferenceCrops(classes, region, picks, cap), batch_size=512, **loader_options(workers, prefetch)):
        rows = torch.tensor([where[int(i)] for i in c], device=device)
        out.index_add_(0, rows, embed(model, x, device))
    model.train(was)
    return F.normalize(out, dim=1)


def eval_set(classes: Classes, region: Region, n: int, seed: int, workers: int, prefetch: int):
    """Fixed camera crops of `n` cards' printings, each with its card's competing classes, and
    the reference crops of those classes (up to `PROTO_CAP` members each), cut once and kept in
    memory for every evaluation."""
    rng = random.Random(seed)
    groups = rng.sample(classes.groups, min(n, len(classes.groups)))
    views, truth, cands = [], [], []
    for k, g in enumerate(groups):
        c = rng.choice(g["classes"])
        face = rng.choice(g["faces"][c])
        vr = random.Random(seed * 7919 + k)
        views.append(camera_crop(load(classes.path(face)), region, vr))
        truth.append(c)
        cands.append(g["classes"])
    picks = sorted({c for cs in cands for c in cs})
    refs, owners = [], []
    for x, c in DataLoader(ReferenceCrops(classes, region, picks, PROTO_CAP), batch_size=512, **loader_options(workers, prefetch)):
        refs.append(x)
        owners.append(c)
    return torch.from_numpy(np.stack(views)), truth, cands, picks, torch.cat(refs), torch.cat(owners)


@torch.no_grad()
def within_top1(model, ev, device) -> float:
    views, truth, cands, picks, refs, owners = ev
    row = {c: k for k, c in enumerate(picks)}
    model.eval()
    run = lambda x: torch.cat([embed(model, x[k : k + 512], device) for k in range(0, len(x), 512)])  # noqa: E731
    protos = torch.zeros(len(picks), model.dim, device=device)
    protos.index_add_(0, torch.tensor([row[int(c)] for c in owners], device=device), run(refs))
    protos = F.normalize(protos, dim=1)
    q = run(views)
    model.train()
    hits = 0
    for i, (t, cs) in enumerate(zip(truth, cands)):
        s = q[i] @ protos[[row[c] for c in cs]].t()
        hits += cs[int(s.argmax())] == t
    return hits / len(truth)


def done_row(rows: list[dict], best: float, args, classes: int) -> dict:
    """The run's final line: the last epoch's numbers, the best within-card top-1 (best.pt, what
    the pipeline exports), and views/s over every epoch."""
    last = rows[-1]
    seconds = sum(r["seconds"] for r in rows)
    return {"done": True, "kind": args.kind, "epoch": last["epoch"], "epochs": args.epochs, "step": last["step"],
            "loss": last["loss"], "train_acc": last["train_acc"], "within_top1": last.get("within_top1"),
            "best_within_top1": best, "classes": classes, "seconds": round(seconds, 1),
            "views_per_s": round(sum(r["views_per_s"] * r["seconds"] for r in rows) / max(seconds, 1e-9))}


def parse_args(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("run")
    ap.add_argument("--kind", required=True, choices=sorted(REGIONS))
    ap.add_argument("--epochs", type=int, help="default: symbol 12, band 14 (KINDS)")
    ap.add_argument("--repeats", type=int, help="views of each class per epoch; default: symbol 64, band 1")
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--workers", type=int, default=default_workers(), help="data workers (default: every core but two)")
    ap.add_argument("--prefetch", type=int, default=2, help="batches each data worker keeps ready, in shared memory")
    ap.add_argument("--lr", type=float, default=2e-3, help="backbone peak learning rate")
    ap.add_argument("--head-lr", type=float, default=1e-2, help="reduction, projection and ArcFace class weights")
    ap.add_argument("--margin", type=float, default=0.3)
    ap.add_argument("--dim", type=int, default=DIM)
    ap.add_argument("--warmup", type=int, default=500, help="steps")
    ap.add_argument("--eval-every", type=int, default=2)
    ap.add_argument("--eval-cards", type=int, default=1000)
    ap.add_argument("--log-every", type=int, default=200, help="steps between running-loss lines (stdout only)")
    ap.add_argument("--limit", type=int, help="only N classes, chosen at random (a smoke run)")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)
    for key, value in KINDS[args.kind].items():
        if getattr(args, key) is None:
            setattr(args, key, value)
    return args


def main():
    args = parse_args()
    run = Path(args.run)
    run.mkdir(parents=True, exist_ok=True)
    clear_partials(run)
    ckpt = load_checkpoint(run)
    if ckpt is not None:
        check_recipe(ckpt, args, RECIPE, run)
        if ckpt["epoch"] >= args.epochs:
            done = done_row(ckpt["rows"], ckpt["best"], args, ckpt["classes"])
            reconcile_log(run / "log.jsonl", ckpt["rows"], "epoch", done)
            print(f"{run / CHECKPOINT}: all {args.epochs} epochs done", flush=True)
            print(json.dumps(done), flush=True)
            return
    torch.manual_seed(args.seed)
    device = torch.device("cuda")
    torch.backends.cudnn.benchmark = True

    region = REGIONS[args.kind]
    classes = Classes(Path(args.data), args.kind, args.limit, args.seed)
    n = len(classes)
    fingerprint = classes.fingerprint()
    if ckpt is not None and ckpt["classes_sha256"] != fingerprint:
        raise SystemExit(f"{run / CHECKPOINT} was trained on other classes ({ckpt['classes']} {args.kind} classes, now {n}): "
                         "its ArcFace weights do not fit these; start a new run directory")
    model = CropEmbedder(region, args.dim, pretrained=ckpt is None).to(device)
    head = ArcFace(n, dim=args.dim, margin=args.margin).to(device)
    started = time.time()
    if ckpt is None:
        head.weight.data.copy_(prototypes(model, classes, region, list(range(n)), device, args.workers, args.prefetch))
        print(f"{n} {args.kind} classes over {sum(map(len, classes.members))} faces; ArcFace weights from reference "
              f"crops in {time.time() - started:.0f} s", flush=True)
    else:
        model.load_state_dict(ckpt["model"])
        head.load_state_dict(ckpt["head"])
        print(f"resumed {run / CHECKPOINT} after epoch {ckpt['epoch']} of {args.epochs} (step {ckpt['step']})", flush=True)
    ev = eval_set(classes, region, args.eval_cards, args.seed + 2, args.workers, args.prefetch)
    opt = torch.optim.AdamW(
        [
            {"params": model.body.parameters(), "lr": args.lr, "weight_decay": 1e-5},
            {"params": [*model.reduce.parameters(), *model.head.parameters()], "lr": args.head_lr, "weight_decay": 1e-4},
            {"params": head.parameters(), "lr": args.head_lr, "weight_decay": 0.0},
        ]
    )
    steps_per_epoch = n * args.repeats // args.batch
    total = steps_per_epoch * args.epochs
    base = [g["lr"] for g in opt.param_groups]  # the peaks, before a checkpoint's scheduled values replace them
    if ckpt is not None:
        opt.load_state_dict(ckpt["optimizer"])

    def set_lr(step):
        f = step / args.warmup if step < args.warmup else 0.5 * (1 + math.cos(math.pi * (step - args.warmup) / max(1, total - args.warmup)))
        for g, b in zip(opt.param_groups, base):
            g["lr"] = b * max(f, 0.01)

    best, step, first, rows = -1.0, 0, 0, []
    if ckpt is None:
        meta = {
            "kind": args.kind, "region": region.meta(args.dim), "view": VIEW, "backbone": BACKBONE, "reduce": REDUCE,
            "params": sum(p.numel() for p in model.parameters()), "classes": n, "classes_sha256": fingerprint,
            "faces": sum(map(len, classes.members)), "eval_cards": len(ev[1]), "views_per_epoch": n * args.repeats,
            "args": vars(args), "torch": torch.__version__,
        }
        (run / "run.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
        print(json.dumps({"epoch": 0, "within_top1": within_top1(model, ev, device)}), flush=True)
    else:
        best, step, first, rows = ckpt["best"], ckpt["step"], ckpt["epoch"], ckpt["rows"]
        reconcile_log(run / "log.jsonl", rows, "epoch")
    log = open(run / "log.jsonl", "a", encoding="utf-8")
    loader = DataLoader(
        TrainViews(classes, region, args.repeats), batch_size=args.batch, shuffle=True, pin_memory=True,
        drop_last=True, persistent_workers=args.workers > 0, **loader_options(args.workers, args.prefetch),
    )
    if ckpt is not None:
        set_rng_state(ckpt["rng"])
        del ckpt
    for epoch in range(first, args.epochs):
        started = time.time()
        loss_sum = torch.zeros((), device=device)
        hit_sum = torch.zeros((), device=device)
        seen = 0
        recent = torch.zeros((), device=device)
        since = time.time()
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
            recent += loss.detach()
            if step % args.log_every == 0:
                rate = args.log_every * args.batch / (time.time() - since)
                print(json.dumps({"step": step, "loss": round(recent.item() / args.log_every, 4), "views_per_s": round(rate)}), flush=True)
                recent.zero_()
                since = time.time()
        row = {"epoch": epoch + 1, "loss": loss_sum.item() / seen, "train_acc": hit_sum.item() / seen,
               "seconds": round(time.time() - started, 1), "views_per_s": round(seen / (time.time() - started)), "step": step}
        if (epoch + 1) % args.eval_every == 0 or epoch + 1 == args.epochs:
            row["within_top1"] = within_top1(model, ev, device)
        state = {k: v.detach().cpu() for k, v in model.state_dict().items()}
        weights = head.weight.detach().float().cpu()
        atomic_save(state, run / "last.pt")
        atomic_save(weights, run / "last.head.pt")
        if row.get("within_top1", -1) > best:
            best = row["within_top1"]
            atomic_save(state, run / "best.pt")
            atomic_save(weights, run / "best.head.pt")
        rows.append(row)
        # Last, the point a restart goes on from: everything above is already on disk.
        atomic_save({
            "model": state, "head": {"weight": weights}, "optimizer": opt.state_dict(), "step": step, "epoch": epoch + 1,
            "best": best, "rows": rows, "rng": rng_state(), "args": vars(args), "classes": n,
            "classes_sha256": fingerprint, "torch": str(torch.__version__),
        }, run / CHECKPOINT)
        print(json.dumps(row), flush=True)
        log.write(json.dumps(row) + "\n")
        log.flush()
    done = done_row(rows, best, args, n)
    print(json.dumps(done), flush=True)
    log.write(json.dumps(done) + "\n")
    log.flush()


if __name__ == "__main__":
    main()
