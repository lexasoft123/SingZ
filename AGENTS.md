# SingZ development rules

Canonical workflow for Claude Code, Codex, and subagents. Before making changes,
read [docs/PROJECT-RULES.md](docs/PROJECT-RULES.md) for product/platform invariants
and commands; use [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for build runbooks.
This file owns workflow policy. Current user and host instructions take
precedence; historical memory must be checked against this checkout.

## Agents and ownership

- Delegate bounded parts of substantial work when supported; small, tightly
  coupled fixes can stay with one agent. Pin interfaces and acceptance checks
  first. Assign explicit files and unique build/scratch directories. Tell each
  worker it is not alone, must preserve others' edits, and must never run
  `git stash`, `checkout`, `reset`, `clean`, `add`, `commit`, or `push`.
- The coordinator owns Git mutations, integrates changes, independently runs
  acceptance checks, and resolves review findings. Independent features/sessions
  use separate worktrees; bounded workers may share one feature's tree only
  with disjoint ownership. Never race edits to headers, dependencies, or outputs.
- Use the least expensive suitable available model within host rules. Claude:
  Sonnet for development/review, Haiku for mechanical work when available;
  expensive architecture models require a user request. Codex: inherit the
  configured model unless an override is authorized. Use available roles or a
  general-purpose agent with the same bounded brief; never invent model IDs.

## Worktrees and builds

- Reuse the task's suitable worktree; independent Codex features use `codex/`
  branches. Never modify a sibling checkout to make this one pass.
- Provision a fresh checkout before app builds/runs/tests with
  `scripts/worktree-setup.sh` or `scripts/worktree-setup.sh --desktop-only`.
  Re-run after dependency changes; rebuild/verify the analyzer after native
  analysis changes. Documentation edits and dependency-free tooling checks do
  not require application setup. Never assume workspace creation ran bootstrap.
- Keep dependencies, generated sources, build state, and project binaries local.
  Share npm/CocoaPods/compiler caches. Reuse third-party binaries only as local
  snapshots with matching revision, target, producer, and checksum receipts;
  never write through or execute mutable sibling artifact links.
- Serialize native builds/bootstrap across worktrees: use self-locking producers
  or `node scripts/with-native-build-lock.mjs --owner <task> -- <command> <args>`.
  Never forge tokens or split lock identity with task temp directories. Stop
  older locking implementations before upgrading; prove the owner and its
  descendants stopped before removing a stale lock.
- Ordinary core/engine builds allow at most four compile edges; stricter producer
  limits apply. Stop above the eight-clang-process ceiling. Keep compiler-cache
  settings per build, never in machine config; see the development runbook.

## Verification and commits

- Add meaningful behavior regressions and prove they reject the old behavior or
  a deliberate negative control. Run applicable checks after integration.
- Bootstrap installs `.githooks` via `node scripts/install-git-hooks.cjs`; run it
  separately if needed. Preserve unrelated hook configurations. Both clients
  use the Git hooks; Claude's tool hook only adds early feedback.
- Before each commit, stage only intended files and delegate independent review
  using [.claude/agents/code-reviewer.md](.claude/agents/code-reviewer.md) in this
  worktree. Address findings; the reviewer records the exact approved index tree
  in the worktree's Git directory. Changed staging requires another review.
- Do not bypass review with `--no-verify` or `SINGZ_SKIP_REVIEW=1` without explicit
  user authorization. Disposable tooling-test fixture repositories may bypass
  hooks to construct test data. Never commit credentials or machine-local links.
- Publishing, pushing, and external messages require applicable user authorization.
