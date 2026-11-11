#!/usr/bin/env python3
"""Strict, unaligned PNG comparison. 0 identical, 1 different, 2 invalid input."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
from PIL import Image, ImageChops


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def compare(reference, candidate, output):
    reference, candidate, output = map(Path, (reference, candidate, output))
    # Fully decode before creating output. Bad or truncated files cannot pass.
    with Image.open(reference) as source:
        if source.format != 'PNG':
            raise ValueError('reference must be a PNG')
        first = source.convert('RGBA')
    with Image.open(candidate) as source:
        if source.format != 'PNG':
            raise ValueError('candidate must be a PNG')
        second = source.convert('RGBA')
    if first.size != second.size:
        raise ValueError(f'pixel dimensions differ: {first.size} vs {second.size}; no resizing allowed')
    if reference.resolve() == candidate.resolve():
        raise ValueError('reference and candidate must be separate files')
    # Profiles change rendered colour even when stored channel values agree.
    with Image.open(reference) as a, Image.open(candidate) as b:
        profile_equal = a.info.get('icc_profile') == b.info.get('icc_profile')
        gamma_equal = a.info.get('gamma') == b.info.get('gamma')
        srgb_equal = a.info.get('srgb') == b.info.get('srgb')
    difference = ImageChops.difference(first, second)
    channels = difference.split()
    magnitude = channels[0]
    for channel in channels[1:]:
        magnitude = ImageChops.lighter(magnitude, channel)
    histogram = magnitude.histogram()
    pixels = first.width * first.height
    changed = pixels - histogram[0]
    mean_error = sum(sum(i * n for i, n in enumerate(channel.histogram())) for channel in channels) / (pixels * 4)
    exact = changed == 0 and profile_equal and gamma_equal and srgb_equal
    report = {
        'reference': str(reference.resolve()), 'candidate': str(candidate.resolve()),
        'reference_sha256': digest(reference), 'candidate_sha256': digest(candidate),
        'width': first.width, 'height': first.height, 'total_pixels': pixels,
        'different_pixels': changed, 'different_percent': changed / pixels * 100,
        'max_channel_error': max(i for i, count in enumerate(histogram) if count),
        'mean_absolute_channel_error': mean_error,
        'difference_bounds': magnitude.getbbox(),
        'icc_profile_equal': profile_equal, 'gamma_equal': gamma_equal,
        'srgb_equal': srgb_equal, 'pixel_exact': exact,
        'scope': 'image pair only; fixture/state/coverage contracts require separate review',
    }
    output.mkdir(parents=True, exist_ok=True)
    # Never overwrite source captures, even if a caller picks their directory as output.
    targets = [output / name for name in ('overlay.png', 'difference.png', 'pair.png', 'report.json')]
    if any(path.resolve() in (reference.resolve(), candidate.resolve()) for path in targets):
        raise ValueError('output would overwrite a source capture')
    Image.blend(first, second, .5).save(targets[0])
    # Every mismatch is visible, including a one-level channel difference.
    red = magnitude.point(lambda v: min(255, max(48, v * 8)) if v else 0)
    Image.merge('RGB', (red, Image.new('L', first.size), Image.new('L', first.size))).save(targets[1])
    pair = Image.new('RGBA', (first.width * 2, first.height))
    pair.paste(first, (0, 0))
    pair.paste(second, (first.width, 0))
    pair.save(targets[2])
    targets[3].write_text(json.dumps(report, indent=2) + '\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = compare(args.reference, args.candidate, args.out)
    except (OSError, ValueError) as error:
        # Clear stale success metadata from a previously completed invocation.
        destination = args.out / 'report.json'
        if destination.resolve() not in (args.reference.resolve(), args.candidate.resolve()):
            args.out.mkdir(parents=True, exist_ok=True)
            destination.write_text(json.dumps({'pixel_exact': False, 'error': str(error)}, indent=2) + '\n')
        print(f'Invalid comparison: {error}', file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result['pixel_exact'] else 1


if __name__ == '__main__':
    sys.exit(main())
