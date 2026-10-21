"""Export a trained printing-evidence network (ev_train.py) and its gallery's rows.

    python ev_export.py <dataset dir> <run dir>/best.pt <out dir> --kind symbol|band [--limit N] [--seed 0]

Writes into <out dir>, for `<kind>`:
  <kind>.onnx          crops [n,3,h,w] -> embedding [n,dim] (opset 17; ImageNet-normalised CHW
                       in, unit length out — the names card_neural::Embedder::load looks up)
  <kind>s.matrix       NSGALLR1: one row per class, the L2-normalised mean of its member faces'
                       reference-crop embeddings — the shipped gallery's rows
  <kind>s.head.matrix  when <checkpoint>.head.pt exists: the class's ArcFace weight, same rows
  <kind>s.json         build_gallery.rs's {source, entries: [{card, name, id, face, covers}]},
                       row for row: bands one entry per printing face, covering that printing;
                       symbols one entry per (symbol set, rarity, stamp), covering every printing
                       that shows it, face "front"; card 0
  <kind>.meta.json     neural.json's evidence CropMeta for this network: width, height, box, dim

`build-gallery --matrix <kind>s.matrix --gallery <kind>s.json --out <kind>s.bin` (card-neural's
`cli` feature) makes the shipped gallery — the mean rows, not the head's. `--limit` and `--seed`
must be the run's (a smoke run's classes are a random subset), and the classes must be the ones
the run trained on: the export refuses others (run.json's `classes_sha256`).
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

from ev_data import REGIONS, Classes, ReferenceCrops
from ev_train import CropEmbedder
from qd_data import normalize


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("checkpoint")
    ap.add_argument("out")
    ap.add_argument("--kind", required=True, choices=sorted(REGIONS))
    ap.add_argument("--limit", type=int, help="the run's --limit (smoke runs)")
    ap.add_argument("--seed", type=int, default=0, help="the run's --seed")
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()
    out = Path(args.out)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    region = REGIONS[args.kind]
    classes = Classes(Path(args.data), args.kind, args.limit, args.seed)
    trained = Path(args.checkpoint).parent / "run.json"
    sha = json.loads(trained.read_text(encoding="utf-8")).get("classes_sha256") if trained.exists() else None
    if sha is None:
        print(f"warning: no classes_sha256 in {trained}; trusting that the run trained on these classes")
    elif sha != classes.fingerprint():
        raise SystemExit(f"the {len(classes)} {args.kind} classes of {args.data} (--limit {args.limit}, --seed {args.seed}) "
                         f"are not the ones {args.checkpoint} trained on: its gallery rows would name the wrong printings")
    out.mkdir(parents=True, exist_ok=True)
    state = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    dim = state["head.weight"].shape[0]
    model = CropEmbedder(region, dim, pretrained=False)
    model.load_state_dict(state)
    model.eval()
    onnx_path = out / f"{args.kind}.onnx"
    torch.onnx.export(
        model, (torch.zeros(2, 3, region.height, region.width),), str(onnx_path),
        input_names=["crops"], output_names=["embedding"], opset_version=17, dynamo=False,
        dynamic_axes={"crops": {0: "n"}, "embedding": {0: "n"}},
    )
    model = model.to(device)

    protos = torch.zeros(len(classes), dim, device=device)
    probe = None
    with torch.no_grad():
        for x, c in DataLoader(ReferenceCrops(classes, region), batch_size=512, num_workers=args.workers):
            crops = normalize(x.to(device))
            e = model(crops).float()
            protos.index_add_(0, c.to(device), e)
            if probe is None:
                probe = (crops[:4].cpu().numpy(), e[:4].cpu().numpy())
    protos = F.normalize(protos, dim=1)
    # The exported graph answers what torch answers.
    got = ort.InferenceSession(str(onnx_path)).run(None, {"crops": probe[0]})[0]
    print(f"onnxruntime vs torch on 4 crops: max |diff| {np.abs(got - probe[1]).max():.2e}; {onnx_path.name} {onnx_path.stat().st_size} bytes")

    def write(name: str, rows: torch.Tensor) -> None:
        rows = rows.cpu().numpy().astype("<f4")
        with open(out / name, "wb") as f:
            f.write(b"NSGALLR1" + struct.pack("<II", *rows.shape) + rows.tobytes())

    write(f"{args.kind}s.matrix", protos)
    head = Path(args.checkpoint).with_suffix(".head.pt")
    if head.exists():
        weights = F.normalize(torch.load(head, map_location="cpu", weights_only=True).float(), dim=1)
        assert weights.shape == protos.shape, f"head {tuple(weights.shape)} against gallery {tuple(protos.shape)}"
        write(f"{args.kind}s.head.matrix", weights)
    entries = [classes.info(c) for c in range(len(classes))]
    gallery = {"version": 1, "source": f"card-neural train/ev_export.py, {args.checkpoint}, {len(entries)} {args.kind} classes", "entries": entries}
    (out / f"{args.kind}s.json").write_text(json.dumps(gallery, ensure_ascii=False), encoding="utf-8")
    (out / f"{args.kind}.meta.json").write_text(json.dumps(region.meta(dim)), encoding="utf-8")
    print(f"exported {len(entries)} {args.kind} classes to {out}")


if __name__ == "__main__":
    main()
