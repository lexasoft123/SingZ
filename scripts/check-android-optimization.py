#!/usr/bin/env python3
"""Check the shipped AAB's optimizer metadata, rather than Gradle settings."""
import json
import sys
import zipfile


def check(bundle_path):
    with zipfile.ZipFile(bundle_path) as bundle:
        report = json.loads(bundle.read('BUNDLE-METADATA/com.android.tools/r8.json'))
        options = report['options']
        for key in ('isObfuscationEnabled', 'isOptimizationsEnabled', 'isShrinkingEnabled'):
            if options.get(key) is not True:
                raise ValueError(f'R8 {key} must be enabled')
        if report.get('resourceOptimization', {}).get('isOptimizedShrinkingEnabled') is not True:
            raise ValueError('R8 optimized resource shrinking must be enabled')
        print('Resource shrinking: optimized (verified in R8 metadata)')
        for category in ('Obfuscation', 'Optimization', 'Shrinking'):
            restricted = float(report['stats'][f'no{category}Percentage'])
            if not 0 <= restricted <= 100:
                raise ValueError(f'Invalid R8 {category} percentage: {restricted}')
            eligible = 100 - restricted
            print(f'{category}: {eligible:.2f}% eligible in R8 metadata')
            if eligible < 25:
                raise ValueError(f'{category} is below the 25% Play threshold')
        if not bundle.read('BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map'):
            raise ValueError('AAB is missing its obfuscation mapping')
        dex_bytes = sum(entry.file_size for entry in bundle.infolist()
                        if entry.filename.endswith('.dex'))
        if dex_bytes == 0:
            raise ValueError('AAB contains no DEX code')
        print(f'Total uncompressed DEX: {dex_bytes:,} bytes; mapping included')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('Usage: check-android-optimization.py APP.aab')
    try:
        check(sys.argv[1])
    except (ValueError, KeyError, zipfile.BadZipFile) as error:
        sys.exit(f'Android optimization check failed: {error}')
