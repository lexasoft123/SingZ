"""Export the pinned ONNX weights; no inference/runtime dependency is shipped.
Requires onnx and numpy only when regenerating this checked-in artifact.
"""
import argparse, hashlib, struct
from pathlib import Path
import numpy as np
import onnx
from onnx import numpy_helper
p=argparse.ArgumentParser(); p.add_argument('model'); p.add_argument('output'); a=p.parse_args()
raw=Path(a.model).read_bytes()
assert hashlib.sha256(raw).hexdigest()=='48130a2e69a5f7ebfdfbd680a85a41dda9dffc9ce810f64481e0c6269ee5661b', 'Unrecognized model'
m=onnx.load(a.model); w={t.name:numpy_helper.to_array(t) for t in m.graph.initializer}
with open(a.output,'wb') as f:
 f.write(b'SZCRPT01')
 for i in range(1,7):
  prefix=f'conv{i}'
  for name in ['weight','bias']:
   f.write(np.asarray(w[prefix+'.'+name],dtype='<f4').tobytes())
  scale=w[prefix+'_BN.weight']/np.sqrt(w[prefix+'_BN.running_var']+np.float32(.001))
  offset=w[prefix+'_BN.bias']-scale*w[prefix+'_BN.running_mean']
  f.write(np.asarray(scale,dtype='<f4').tobytes()); f.write(np.asarray(offset,dtype='<f4').tobytes())
 for name in ['weight','bias']:
  f.write(np.asarray(w['classifier.'+name],dtype='<f4').tobytes())
print(hashlib.sha256(Path(a.output).read_bytes()).hexdigest())
