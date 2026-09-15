#!/usr/bin/env python3
"""Render measured pitch tracks; absent series are omitted, never invented."""
import argparse
import json
import os
from pathlib import Path

os.environ.setdefault('MPLCONFIGDIR', '/private/tmp/singz-pitch-eval/mpl-cache')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

p = argparse.ArgumentParser()
p.add_argument('--output', type=Path, default=Path('/private/tmp/singz-pitch-eval'))
p.add_argument('--id', default='downloads-ee0422e9850a')
p.add_argument('--title', default='Pink Floyd — Time')
p.add_argument('--labels', nargs='+', default=['baseline', 'updated', 'updated-lead', 'reference', 'reference-lead'])
p.add_argument('--detail-start', type=float, default=130)
p.add_argument('--detail-end', type=float, default=230)
args = p.parse_args()
colors = ['#bd5555', '#247893', '#238b45', '#b6a1c9', '#695589']
fig, axes = plt.subplots(2, 1, figsize=(15, 7), gridspec_kw={'height_ratios': [1, 1.3]})
count = 0
duration = 0
for series_index, label in enumerate(args.labels):
    color = colors[series_index % len(colors)]
    path = args.output / label / (args.id + '.json')
    if not path.exists():
        continue
    data = json.loads(path.read_text())
    duration = max(duration, data.get('duration', 0))
    hz = np.asarray(data['f0'])
    keep = hz > 0
    times = np.asarray(data['times']) if 'times' in data else np.arange(len(hz)) * data['hopSec'] + 1024/(44100/3)/2
    midi = 69 + 12*np.log2(hz[keep]/440)
    for axis in axes:
        axis.scatter(times[keep], midi, s=2, alpha=.6, color=color, label=label)
    count += 1
for axis in axes:
    axis.set_yticks([36, 48, 60, 72, 84], ['C2', 'C3', 'C4', 'C5', 'C6'])
    axis.set_ylim(30, 90)
    axis.set_xlabel('Time (seconds)')
    axis.set_ylabel('Estimated pitch')
    axis.grid(alpha=.2)
    axis.spines[['top', 'right']].set_visible(False)
axes[0].set_title(f'{args.title}: full-duration vocal-stem analysis', loc='left', fontweight='bold')
axes[0].legend(loc='upper right', markerscale=4)
axes[0].set_xlim(0, duration)
axes[1].set_xlim(args.detail_start, args.detail_end)
axes[1].set_title(f'Detail: {args.detail_start:g}–{args.detail_end:g} seconds', loc='left')
fig.text(.07, .02, 'Measured model estimates, not annotated ground truth. Harmony and octave disagreements require listening or a score.\nNative forward windows aligned at their centers; CREPE uses centered windows. Silence/unvoiced frames omitted.', fontsize=9, color='#444444')
fig.tight_layout(rect=[0, .065, 1, 1])
fig.savefig(args.output / 'time-pitch-comparison.png', dpi=160)
fig.savefig(args.output / 'time-pitch-comparison.svg')
print(json.dumps({'series': count, 'image': str(args.output / 'time-pitch-comparison.png')}))
