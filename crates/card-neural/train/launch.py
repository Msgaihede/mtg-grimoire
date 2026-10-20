"""Start a training run on the deployed app and return at once.

    modal deploy crates/card-neural/train/modal_app.py
    python crates/card-neural/train/launch.py --run 2026-11 [--no-detector] [--cpu 16]
           [--memory-gib 24] [--budget-usd 10] [--smoke] [--git-sha <sha>]

Prints one JSON line, `{"run": …, "call_id": …}`. The run goes on on Modal for an hour or two;
`DONE.json` in `runs/<run>/` on the `card-neural` Volume says how it ended, and
`.github/workflows/neural-deliver.yml` picks it up from there. Auth: `MODAL_TOKEN_ID` and
`MODAL_TOKEN_SECRET` in the environment, or `modal token new` on a desk.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

import modal

sys.path.insert(0, str(Path(__file__).parent))
import budget  # noqa: E402

APP_NAME = "card-neural-train"
RUN_NAME = re.compile(r"^\d{4}-\d{2}(-\d{2}-\d{4})?(-smoke)?$")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="YYYY-MM for the monthly run, YYYY-MM-DD-HHMM by hand")
    ap.add_argument("--no-detector", action="store_true", help="retrain the embedder and gallery only")
    ap.add_argument("--cpu", type=float, default=16.0, help="physical cores a training container gets")
    ap.add_argument("--memory-gib", type=float, default=24.0)
    ap.add_argument("--budget-usd", type=float, default=budget.HARD_LIMIT_USD)
    ap.add_argument("--smoke", action="store_true", help="one epoch / 300 steps: the plumbing, for cents")
    ap.add_argument("--git-sha", default=os.environ.get("GITHUB_SHA", ""))
    args = ap.parse_args()

    if not RUN_NAME.match(args.run):
        sys.exit(f"--run {args.run!r} is not YYYY-MM or YYYY-MM-DD-HHMM")
    # Refuses a budget over the hard limit, or one that leaves nothing to train with.
    shares = budget.shares(args.budget_usd, not args.no_detector)
    rate = budget.rate_per_s("L4", args.cpu, args.memory_gib)
    if not 1 <= args.cpu <= 64 or not 4 <= args.memory_gib <= 256:
        sys.exit("--cpu must be 1–64 physical cores and --memory-gib 4–256")

    pipeline = modal.Function.from_name(APP_NAME, "pipeline")
    call = pipeline.spawn(
        run=args.run,
        detector=not args.no_detector,
        cpu=args.cpu,
        memory_gib=args.memory_gib,
        budget_usd=args.budget_usd,
        smoke=args.smoke,
        git_sha=args.git_sha,
    )
    print(json.dumps({
        "run": args.run,
        "call_id": call.object_id,
        "shares_usd": {k: round(v, 2) for k, v in shares.items()},
        "training_hours_at_most": {
            k: round(budget.max_seconds(v, rate) / 3600, 2) for k, v in shares.items()
            if k in ("embedder", "detector")
        },
    }), flush=True)


if __name__ == "__main__":
    main()
