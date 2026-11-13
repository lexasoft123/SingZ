"""Dependency-free source gate for the isolated callback leaf; no hardware."""
import pathlib
import re
import sys

root = pathlib.Path(__file__).parent
text = (root / 'core.cpp').read_text()
forbidden = r'\b(mutex|lock_guard|unique_lock|shared_ptr|make_unique|vector|string|printf|fprintf|iostream|fstream|sleep|malloc|calloc|realloc|free|new|delete|throw|catch)\b'
# Comments describe contracts and are not executable code.
def check(source):
    source = re.sub(r'//[^\n]*|/\*.*?\*/', '', source, flags=re.S)
    return not re.search(forbidden, source)
if not check(text):
    sys.exit('Forbidden callback facility in core.cpp')
if check(text + '\nvoid negative() { malloc(4); }'):
    sys.exit('Policy negative control did not reject allocation')
if 'offset += 256' not in text or 'result.missingFrames' not in text:
    sys.exit('Split reader/counting contract missing')
print('monitor spike callback source policy and negative control passed')
