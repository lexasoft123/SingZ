# SingZ development rules

Canonical workflow for Claude Code, Codex, and subagents. This file owns workflow
policy. Before editing, read applicable sections of
[docs/PROJECT-RULES.md](docs/PROJECT-RULES.md) for product/platform invariants and
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup, build, test, or release
runbooks. Follow relevant references as needed; small documentation or mechanical
edits do not require unrelated guides. Current user and host instructions take
precedence; historical memory must be checked against this checkout.

## Private development handbook

Before work involving team-managed hosts, deployment, remote or hardware testing,
profiling, or shared-device scheduling, read the private `singz-dev` handbook:
`README.md`, `docs/hosts.md`, `docs/testing.md`, and the relevant platform runbook.
Use the checkout identified by `SINGZ_DEV_DIR` when set; otherwise locate the
team's private `singz-dev` checkout or access the private repository through the
team account. Do not assume a worktree's sibling directory is the handbook.

`singz-dev` owns internal host inventory, access and credential-handling
instructions, deployment topology, device reservations and host-specific test
recipes. This repository owns portable build/test commands, product invariants
and reusable test harnesses. Check dated handbook evidence against the current
checkout and coordinate any exclusive device window before remote operations.
Give delegated agents the relevant private runbook references and constraints.

Keep internal addresses, usernames, machine-specific paths, access configuration,
private recordings and diagnostic receipts in `singz-dev` or approved private
artifact storage. Do not copy them into this repository, public PRs, issues,
commit messages, CI logs or release notes; publish only sanitized validation
summaries. Never put credential values in either repository. Record operational
changes in the handbook rather than duplicating its inventory here.

If private access is unavailable, continue portable local checks and report the
missing internal verification. Ask for the handbook location/access before
host-dependent work; never guess an endpoint or reconstruct private setup from
historical public notes. Reading a runbook does not authorize deployments,
reboots, credential access or external publication.

## Agents and ownership

- For substantial work, state the goal, milestones, ownership, and acceptance
  checks before editing. Keep small fixes direct; replan affected work when
  evidence invalidates the approach. Use persistent plans when duration or
  coordination warrants them.
- Delegate bounded work when parallel execution, isolated investigation, or fresh
  review adds value; keep small, tightly coupled fixes direct. Pin interfaces and
  acceptance checks first. Assign explicit files and unique build/scratch
  directories. Tell each worker it is not alone, must preserve others' edits, and
  must never run
  `git stash`, `checkout`, `reset`, `clean`, `add`, `commit`, or `push`.
- The coordinator owns Git mutations, integrates changes, independently runs
  acceptance checks, and resolves review findings. Independent features/sessions
  use separate worktrees; bounded workers may share one feature's tree only
  with disjoint ownership. Never race edits to headers, dependencies, or outputs.
- Select agent models autonomously within host rules, optimizing cost per
  verified result, including retries and supervision. Match capability and effort
  to task complexity and risk; escalate when results justify it. Use only model
  IDs and roles available in this environment. Keep briefs bounded; do not restart
  useful running work merely to change models.
- Complete the authorized goal autonomously through concrete milestones. Use logs,
  errors, and failing tests to fix root causes with the smallest sound change; defer
  unrelated polish. Run meaningful checks at integration checkpoints and repeat
  when changes, failures, or new risks justify it. Required staged review remains
  mandatory.

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
- Native builds in different worktrees may run in parallel; keep each build
  within its compile-edge limit. Ordinary core/engine builds allow at most four
  compile edges; stricter producer limits apply. Stop a build above eight clang
  processes. Never run two of the same vendor producer (`vendor-llama.sh`,
  `vendor-crispasr.sh`) at once. Keep compiler-cache settings per build, never
  in machine config; see the development runbook.

## Verification and commits

- Add meaningful behavior regressions and prove they reject the old behavior or
  a deliberate negative control. Run applicable checks after integration.
  Follow applicable CI checks to completion; report evidence and any unverified
  behavior before declaring completion.
- Record durable lessons from corrections in existing canonical rules or
  documentation when they prevent recurrence; avoid task-specific policy and
  duplicate lesson logs. Periodically prune stale or redundant rules, especially
  after model or workflow changes.
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
