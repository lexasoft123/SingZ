"""Regenerate the UIKit-owned fonts; no private prototype faces are produced."""
from pathlib import Path
import subprocess,sys
script=Path(__file__).resolve().parents[3].parent/'singz-ui/scripts/gen-fonts.py'
subprocess.run([sys.executable,str(script)],check=True)
