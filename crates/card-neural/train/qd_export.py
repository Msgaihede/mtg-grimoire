"""Export a trained Quickdraw-shaped embedder (qd_train.py) as a model directory the crate loads.

    python qd_export.py <dataset dir> <checkpoint.pt> <out dir> [--head-only] [--detector <detector.onnx>]

Writes into <out dir>:
  embedder.onnx      crops [n,3,128,128] -> embedding [n,128] (opset 17; no gallery inside)
  gallery.matrix     NSGALLR1: one row per look, the L2-normalised mean of its members' reference
                     embeddings (embed::Matrix)
  gallery.head.matrix, gallery.mix.matrix
                     when <checkpoint>.head.pt exists (qd_train.py saves one): the look's ArcFace
                     class weight, and its blend with the mean — same rows, same gallery.json
  gallery.json       per row: card group (oracle id), name, the printing a decision reports, its
                     face, and every printing the look stands for (gallery::Gallery)
  neural.meta.json   with `--detector` only: DLNEURAL1 with Quickdraw's thresholds and decode
                     constants and the aimed ranking, pointing at that detector (a
                     Quickdraw-contract detector) and embedder.onnx — the lab's replay reads it;
                     the app reads the hand-kept models/neural.json instead

`--head-only` writes embedder.onnx, gallery.head.matrix and gallery.json alone, with no pass over
every face's clean scan: when the run trained on this dataset's looks.json, every look has a
trained class weight, and the class weights are the gallery the app ships (`build-gallery`). It
refuses a looks.json other than the one the run trained on (run.json's `looks_sha256`).

The replay then runs it as `--meta <out>/neural.meta.json --gallery <out>/gallery.json
--matrix <out>/gallery.matrix`, with that detector or with `--oracle <bundle> --detector oracle`.
"""
import argparse
import json
import struct
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from qd_data import CROP_BOX, Looks, ReferenceViews, load, normalize, reference_view
from qd_model import Embedder
from runs import file_sha256

THRESHOLDS = {
    "detLogit": -1, "detAccept": 0.5, "detInstant": 0.6, "accept": 0.6, "margin": 0.12, "instant": 0.7,
    "instantMargin": 0.18, "weak": 0.5, "weakMargin": 0.05, "support": 0.48, "supportMargin": 0.08,
    "detSupport": 0.8, "flipSure": 0.4,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("checkpoint")
    ap.add_argument("out")
    ap.add_argument("--head-only", action="store_true",
                    help="the class weights as the gallery, without the clean-scan pass over every face")
    ap.add_argument("--detector", help="a detector ONNX with Quickdraw's contract: also write neural.meta.json")
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()
    out = Path(args.out)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    head = Path(args.checkpoint).with_suffix(".head.pt")
    looks = Looks(Path(args.data))
    if args.head_only:
        if not head.exists():
            raise SystemExit(f"--head-only needs the class weights, {head}")
        trained = Path(args.checkpoint).parent / "run.json"
        sha = json.loads(trained.read_text(encoding="utf-8")).get("looks_sha256") if trained.exists() else None
        if sha is None:
            print(f"warning: no looks_sha256 in {trained}; trusting that the run trained on this looks.json")
        elif sha != file_sha256(Path(args.data) / "looks.json"):
            raise SystemExit(f"{args.data}/looks.json is not the one {args.checkpoint} trained on: its rows "
                             "would name the wrong looks; export without --head-only, or from the training's dataset")
    out.mkdir(parents=True, exist_ok=True)
    model = Embedder(pretrained=False)
    model.load_state_dict(torch.load(args.checkpoint, map_location="cpu", weights_only=True))
    model.eval()

    torch.onnx.export(
        model, (torch.zeros(2, 3, 128, 128),), str(out / "embedder.onnx"),
        input_names=["crops"], output_names=["embedding"], opset_version=17, dynamo=False,
        dynamic_axes={"crops": {0: "n"}, "embedding": {0: "n"}},
    )
    model = model.to(device)

    def write(name: str, rows: torch.Tensor) -> None:
        rows = rows.cpu().numpy().astype("<f4")
        with open(out / name, "wb") as f:
            f.write(b"NSGALLR1" + struct.pack("<II", *rows.shape) + rows.tobytes())

    rows = len(looks.looks)
    if args.head_only:
        x = torch.from_numpy(np.stack([reference_view(load(looks.path(l["rep"]))) for l in looks.looks[:4]]))
        with torch.no_grad():
            crops = normalize(x.to(device))
            probe = (crops.cpu().numpy(), model(crops).float().cpu().numpy())
    else:
        refs = ReferenceViews(looks)
        protos = torch.zeros(rows, 128, device=device)
        probe = None
        with torch.no_grad():
            for x, idx in DataLoader(refs, batch_size=256, num_workers=args.workers):
                crops = normalize(x.to(device))
                e = model(crops).float()
                protos.index_add_(0, idx.to(device), e)
                if probe is None:
                    probe = (crops[:4].cpu().numpy(), e[:4].cpu().numpy())
        protos = F.normalize(protos, dim=1)
    # The exported graph answers what torch answers.
    sess = ort.InferenceSession(str(out / "embedder.onnx"))
    got = sess.run(None, {"crops": probe[0]})[0]
    print(f"onnxruntime vs torch on 4 crops: max |diff| {np.abs(got - probe[1]).max():.2e}")

    if not args.head_only:
        write("gallery.matrix", protos)
    if head.exists():
        # The ArcFace class weights, learned against camera views, and their blend with the
        # clean-scan means: two more galleries over the same rows, for `replay --matrix`.
        weights = F.normalize(torch.load(head, map_location="cpu", weights_only=True).float().to(device), dim=1)
        assert weights.shape == (rows, 128), f"head {tuple(weights.shape)} against gallery {(rows, 128)}"
        write("gallery.head.matrix", weights)
        if args.head_only:
            print(f"gallery.head.matrix from {head.name}")
        else:
            write("gallery.mix.matrix", F.normalize(protos + weights, dim=1))
            print(f"also gallery.head.matrix and gallery.mix.matrix from {head.name}")
    groups: dict[str, int] = {}
    entries = []
    for l in looks.looks:
        group = groups.setdefault(l.get("oracle_id") or l["name"], len(groups))
        covers = list(dict.fromkeys(fid[:36] for fid in l["members"]))
        entries.append({
            "card": group,
            "name": l.get("card_name") or l["name"],
            "id": l["rep"][:36],
            "face": "back" if len(l["rep"]) > 36 else "front",
            "covers": covers,
        })
    gallery = {"version": 1, "source": f"card-neural train/qd_export.py, {args.checkpoint}, {len(entries)} looks", "entries": entries}
    (out / "gallery.json").write_text(json.dumps(gallery, ensure_ascii=False), encoding="utf-8")
    if args.detector:
        meta = {
            "format": "DLNEURAL1", "version": 1, "entries": len(entries),
            "detector": {"url": str(Path(args.detector).resolve()).replace("\\", "/"), "width": 192, "height": 320, "stride": 8, "cornerNorm": 64},
            "embedder": {"url": "embedder.onnx", "width": 128, "height": 128, "box": list(CROP_BOX), "maxBatch": 6, "dim": 128, "topk": 10},
            "maxCards": 3, "thresholds": THRESHOLDS,
            # The card under the frame's middle is the one a frame votes for, recognised or not
            # (meta::Ranking::Aimed); Quickdraw's own rule lets a recognised neighbour outvote it.
            "ranking": "aimed",
        }
        (out / "neural.meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(f"exported {len(entries)} looks to {out}")


if __name__ == "__main__":
    main()
