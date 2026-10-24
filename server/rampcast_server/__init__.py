import sys
from pathlib import Path

# The decision engine lives in the repo-root package rampcast/engine/; make it importable from server/.
_ROOT = str(Path(__file__).resolve().parents[2])
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
