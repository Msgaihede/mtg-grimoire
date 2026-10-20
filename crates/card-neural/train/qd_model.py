"""The Quickdraw-shaped embedder: timm MobileNetV4-conv-small (from the Apache-2.0
`e2400_r224_in1k` ImageNet weights Quickdraw's own is fine-tuned from), its pooled 1 280-wide head
features, `Linear(1280 -> 128)`, L2-normalised — the graph `crates/card-neural` loads as
`crops [n,3,128,128] -> embedding [n,128]`.
"""
import torch
import torch.nn.functional as F
from torch import nn

BACKBONE = "mobilenetv4_conv_small.e2400_r224_in1k"
DIM = 128


class Embedder(nn.Module):
    def __init__(self, pretrained: bool = True, dim: int = DIM):
        super().__init__()
        import timm

        self.body = timm.create_model(BACKBONE, pretrained=pretrained, num_classes=0)
        with torch.no_grad():
            width = self.body.eval()(torch.zeros(1, 3, 128, 128)).shape[1]
        self.body.train()
        self.head = nn.Linear(width, dim)

    def forward(self, crops: torch.Tensor) -> torch.Tensor:
        return F.normalize(self.head(self.body(crops)), dim=1, eps=1e-6)


class ArcFace(nn.Module):
    """Additive angular margin over one class per look; training only."""

    def __init__(self, classes: int, dim: int = DIM, scale: float = 30.0, margin: float = 0.3):
        super().__init__()
        self.weight = nn.Parameter(torch.empty(classes, dim))
        nn.init.normal_(self.weight, std=0.01)
        self.scale, self.margin = scale, margin

    def forward(self, emb: torch.Tensor, labels: torch.Tensor):
        cos = emb @ F.normalize(self.weight, dim=1).t()
        target = cos.gather(1, labels[:, None]).clamp(-1 + 1e-6, 1 - 1e-6)
        with_margin = torch.cos(torch.acos(target) + self.margin)
        logits = self.scale * cos.scatter(1, labels[:, None], with_margin)
        return F.cross_entropy(logits.float(), labels), cos
