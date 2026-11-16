"""Accept only the named regression assertion, not an arbitrary nonzero exit."""
import subprocess
import sys


def matches(result, expected):
    return result.returncode == 1 and result.stdout == '' and result.stderr == f'FAIL: {expected}\n'


if sys.argv[1:] == ['--self-test']:
    expected = 'q==320'
    assert matches(subprocess.CompletedProcess([], 1, '', 'FAIL: q==320\n'), expected)
    for code, out, err in [(0, '', ''), (-11, '', 'FAIL: q==320\n'),
                           (1, '', 'unrelated failure\n'), (1, '', 'FAIL: q==320\nASan error\n'),
                           (1, 'unexpected output\n', 'FAIL: q==320\n')]:
        assert not matches(subprocess.CompletedProcess([], code, out, err), expected)
else:
    binary, case, expected = sys.argv[1:]
    result = subprocess.run([binary, case], capture_output=True, text=True, timeout=90)
    if not matches(result, expected):
        sys.exit(f'Expected exit 1 and exactly FAIL: {expected!s}; got exit {result.returncode}, '
                 f'stdout={result.stdout!r}, stderr={result.stderr!r}')
    print(f'Compiled mutant rejected by expected assertion: {expected}')
