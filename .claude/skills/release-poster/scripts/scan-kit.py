#!/usr/bin/env python3
"""Refuse to let a post kit into git carrying anything machine-specific.

The kit is committed to a PUBLIC repo and is mostly base64, so nothing in it is
legible to a casual eye or to a plain grep — a random b64 substring matches
whatever you search for. This strips the blobs first and looks at the ~19 KB of
real markup underneath, then checks the blobs STRUCTURALLY.

It lives as a file rather than as a one-liner in SKILL.md on purpose: the
one-liner had to survive a markdown fence, a shell double-quoted string and a
Python string literal, and this session already shipped one bug of exactly that
shape (a \\n that needed to be \\\\n, which silently killed a whole <script>).

Exit 0 = clean, 1 = something to look at, 2 = usage.
"""
import base64, binascii, re, sys, zlib

# Any ROOTED path, not a hand-picked pair of prefixes. The pair was /Users/ and
# /home/, and it prints a comfortable 0 for the path an ordinary Mac actually
# produces: tmpdir is /var/folders/<per-user-hash>/T, and that hash identifies a
# user as surely as a name. It read green only because this sandbox happens to
# use /private/tmp. The list is what is CHECKED — a 0 claims no more than that.
ROOTS = ('Users', 'home', 'Volumes', 'var', 'opt', 'usr', 'etc', 'private',
         'Applications', 'tmp', 'mnt', 'media', 'srv', 'root', 'System',
         'Library', 'Network')
CHECKS = [
    ('rooted path', r'(?<![\w.~])/(?:' + '|'.join(ROOTS) + r')/\S*'),
    # (?<![A-Za-z0-9]) or every https:// reads as drive Z: — it did, on the
    # first version of this file, which is the whole argument for the positive
    # control in SKILL.md rather than trusting a green run.
    ('windows path', r'(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![/])\S*'),
    ('unc path', r'\\\\[A-Za-z0-9_.-]+\\\S*'),
    # ~/ AND ~user/ — the tilde-username form slipped the first version. But a
    # username must START with a letter or underscore, or "~3/4 time" and "~1/2
    # as long" read as home directories — and this is a music app whose captions
    # are asked to carry exactly that register (approximations, time signatures,
    # sizes). A gate that cries wolf teaches the reader to skim past reds, which
    # is the same failure as a green that means nothing.
    ('home-relative', r'(?<![\w/])~(?:[A-Za-z_][\w.-]*)?/\S*'),
    ('ipv4', r'\b\d{1,3}(?:\.\d{1,3}){3}\b'),
    # CLAUDE.md's rule is machine names, IPs AND lab paths. A path-shaped
    # scanner covers two of the three, so identity gets its own checks: a
    # non-web URL scheme is always a machine, and .local/.lan/.internal is a
    # hostname on somebody's network.
    ('non-web url', r'(?<![A-Za-z0-9])(?:smb|afp|nfs|ftp|sftp|ssh|vnc|file)://\S*'),
    # These two can fire on content somebody MEANT to publish — a support
    # address in a caption is a disclosure decision, not a bug. They stop the
    # commit so a human looks; they do not claim a leak.
    ('host name', r'\b[\w.-]+\.(?:local|lan|internal|home\.arpa)\b'),
    ('user@host', r'\b[\w.-]+@[\w-]+(?:\.[\w-]+)+\b'),
    # Relative and still identifying: posterShown() emits a repo-relative path,
    # and SINGZ_REPO pointed at the parent checkout while running from a
    # worktree yields .claude/worktrees/<codename>/… — which no rooted-path
    # check can see, because it is not rooted.
    ('worktree name', r'(?<![\w.~])\.claude/worktrees/\S*'),
]
# Metadata a camera, an exporter or a screenshot tool leaves behind. Checked
# STRUCTURALLY: running the path regexes over decoded bytes is meaningless —
# compressed image data contains "~/" and "D:/" by chance, constantly.
PNG_META = ('tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME')


def png_meta(raw):
    out, i = [], 8
    while i + 12 <= len(raw):
        ln = int.from_bytes(raw[i:i + 4], 'big')
        typ = raw[i + 4:i + 8].decode('latin-1', 'replace')
        if typ in PNG_META:
            body = raw[i + 8:i + 8 + ln]
            if typ == 'zTXt':
                try:
                    body = zlib.decompress(body.split(b'\0', 2)[-1])
                except zlib.error:
                    pass
            out.append(f'{typ} {body[:120]!r}')
        i += 12 + ln
        if typ == 'IEND':
            break
    return out


def main(path):
    raw = open(path, encoding='utf-8').read()
    problems = []

    for n, b64 in enumerate(re.findall(r'base64,([A-Za-z0-9+/=]+)', raw), 1):
        try:
            blob = base64.b64decode(b64)
        except (binascii.Error, ValueError):
            continue
        if blob[:8] == b'\x89PNG\r\n\x1a\n':
            for c in png_meta(blob):
                problems.append(f'blob {n}: PNG metadata — {c}')

    surface = re.sub(r'base64,[A-Za-z0-9+/=]+', 'base64,<BLOB>', raw)
    print(f'readable surface: {len(surface)} bytes of {len(raw)}')
    for label, pat in CHECKS:
        hits = sorted(set(re.findall(pat, surface)))
        print(f'  {label:14} {len(hits)}' + (f'  {hits[:3]}' if hits else ''))
        problems += [f'{label}: {h}' for h in hits]

    hosts = sorted(set(re.findall(r'https?://([^/"\s)<]+)', surface)))
    print(f'  hosts          {hosts}')

    if problems:
        print('\nNOT CLEAN — do not commit:')
        for p in problems:
            print(f'  {p}')
        return 1
    print('\nclean on every checked pattern, and no PNG carries metadata.')
    print('Now read the host list: it must name only what the captions and the')
    print('download rows actually link to.')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(f'usage: {sys.argv[0]} <post-kit.html>', file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
