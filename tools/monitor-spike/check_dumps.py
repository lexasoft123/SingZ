"""Parse real serializer output; no audio device or filesystem fixture required."""
import csv
import io
import json
import subprocess
import sys

binary = sys.argv[1]
def run(mode):
    return subprocess.run([binary, mode], check=True, text=True, capture_output=True, timeout=30).stdout
j = json.loads(run('diagnostic-json'))
c = list(csv.DictReader(io.StringIO(run('diagnostic-csv'))))
assert j['schema'] == 1 and j['dropped'] == 0
assert len(j['rows']) == len(c) == 2
assert len(j['delta_histogram']) == 258 and sum(j['delta_histogram']) == 1
for jr, cr in zip(j['rows'], c):
    assert jr.keys() == cr.keys()
    for key, value in jr.items():
        assert float(cr[key]) == value, (key, cr[key], value)
assert j['rows'][1]['flags'] & 4  # rejected interval preserved
assert j['rows'][1]['delta_ns'] - j['rows'][1]['expected_ns'] == 50000
print('CSV/JSON serializer round-trip passed')
