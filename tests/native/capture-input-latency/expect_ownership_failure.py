"""A compiled release-early mutant must fail the named ownership regression."""
import os
import subprocess
import sys

node, script, addon = sys.argv[1:]
env = os.environ.copy()
runtime = env.pop("SINGZ_TEST_NODE_SANITIZER_RUNTIME", "")
if runtime:
    env["DYLD_INSERT_LIBRARIES"] = runtime
result = subprocess.run([node, script, addon], capture_output=True, text=True, timeout=15, env=env)
expected = "FAIL: disarmed take retains capture ownership\n"
if result.returncode != 1 or result.stdout or result.stderr != expected:
    sys.exit(f"Expected ownership assertion only; got {result.returncode}, "
             f"stdout={result.stdout!r}, stderr={result.stderr!r}")
print("Compiled early-release mutant rejected by the disarmed-take ownership regression")
