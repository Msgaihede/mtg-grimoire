"""The card detector, shaped like Quickdraw's (the scanner lab's docs/neural-scanner.md §1.3, §1.3a):
timm `mobilenetv3_small_075` from its Apache-2.0 `lamb_in1k` ImageNet weights (Quickdraw's own
starting point), without its classifier head, then an FPN-lite neck — 1×1 laterals `l3`/`l4`/
`l5` on the stride-8/16/32 features, nearest upsampling, depthwise-separable `m4`/`m3` — and one
stride-8 head of ten channels. The graph the crate loads (`detect::Detector`):

    image [1, 3, h, w] (ImageNet-normalised RGB) -> maps [1, 10, h/8, w/8]

channel 0 a card-centre logit, 1–8 the corners' offsets from the cell centre in units of 64
input pixels in raw order, 9 the upside-down logit (qd_detect_data.py says what raw means).

    python qd_detector.py export <checkpoint.pt> <out dir> [--meta <embedder model dir>/neural.meta.json]

writes `detector.onnx` (opset 17, any input size, checked against onnxruntime) and, with
`--meta`, a `neural.meta.json` beside it that pairs this detector with that embedder.
"""
import argparse
import json
from pathlib import Path

import torch
import torch.nn.functional as F
from torch import nn

BACKBONE = "mobilenetv3_small_075.lamb_in1k"


def _sep(c: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(c, c, 3, padding=1, groups=c, bias=False), nn.BatchNorm2d(c), nn.ReLU(inplace=True),
        nn.Conv2d(c, c, 1, bias=False), nn.BatchNorm2d(c), nn.ReLU(inplace=True),
    )


class Detector(nn.Module):
    def __init__(self, pretrained: bool = True, neck: int = 48):
        super().__init__()
        import timm

        self.body = timm.create_model(BACKBONE, pretrained=pretrained, features_only=True, out_indices=(2, 3, 4))
        c8, c16, c32 = self.body.feature_info.channels()
        self.l3, self.l4, self.l5 = nn.Conv2d(c8, neck, 1), nn.Conv2d(c16, neck, 1), nn.Conv2d(c32, neck, 1)
        self.m4, self.m3, self.head = _sep(neck), _sep(neck), _sep(neck)
        self.out = nn.Conv2d(neck, 10, 1)
        with torch.no_grad():
            self.out.bias.zero_()
            self.out.bias[0] = -4.0  # few cells hold a card's centre
            self.out.weight[1:9].mul_(0.1)

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        f8, f16, f32 = self.body(image)
        p = self.m4(self.l4(f16) + F.interpolate(self.l5(f32), size=f16.shape[-2:], mode="nearest"))
        p = self.m3(self.l3(f8) + F.interpolate(p, size=f8.shape[-2:], mode="nearest"))
        return self.out(self.head(p))


def export(checkpoint: str, out: Path, meta: str | None) -> None:
    import numpy as np
    import onnxruntime as ort

    out.mkdir(parents=True, exist_ok=True)
    model = Detector(pretrained=False)
    model.load_state_dict(torch.load(checkpoint, map_location="cpu", weights_only=True))
    model.eval()
    path = out / "detector.onnx"
    torch.onnx.export(
        model, (torch.zeros(1, 3, 192, 320),), str(path), input_names=["image"], output_names=["maps"],
        opset_version=17, dynamo=False, dynamic_axes={"image": {2: "h", 3: "w"}, "maps": {2: "gh", 3: "gw"}},
    )
    sess = ort.InferenceSession(str(path))
    for h, w in ((192, 320), (320, 192)):
        x = torch.randn(1, 3, h, w)
        with torch.no_grad():
            want = model(x).numpy()
        got = sess.run(None, {"image": x.numpy()})[0]
        print(f"onnxruntime vs torch at {w}x{h}: max |diff| {np.abs(got - want).max():.2e}")
    if meta:
        m = json.loads(Path(meta).read_text(encoding="utf-8"))
        base = Path(meta).resolve().parent
        m["detector"] = {"url": str(path.resolve()).replace("\\", "/"), "width": 192, "height": 320, "stride": 8, "cornerNorm": 64}
        emb = m["embedder"]["url"]
        if not Path(emb).is_absolute():
            m["embedder"]["url"] = str((base / emb).resolve()).replace("\\", "/")
        # Our pair ranks by aim (qd_export.py), unless the meta it starts from names a ranking.
        m.setdefault("ranking", "aimed")
        (out / "neural.meta.json").write_text(json.dumps(m, indent=1), encoding="utf-8")
        print(f"neural.meta.json pairs {path.name} with {m['embedder']['url']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["export"])
    ap.add_argument("checkpoint")
    ap.add_argument("out")
    ap.add_argument("--meta")
    a = ap.parse_args()
    export(a.checkpoint, Path(a.out), a.meta)
