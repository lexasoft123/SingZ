/**
 * The TypeScript end of tests/shared/core/plan-project-cases.json. The native
 * desktop runs the same rows against `plan_project` in drive_plan.rs
 * (experiments/gpui-player/src/core_case_tables_tests.rs).
 */
import { describe, expect, it } from 'vitest'
import cases from '../shared/core/plan-project-cases.json'
import { planProject, type ProjectSnapshot, type RemoteProject } from '../../src/main/sync-plan'

describe('planProject — the shared case table', () => {
  it.each(cases)('$name', ({ local, remote, expected }) => {
    const plan = planProject(local as ProjectSnapshot, remote as RemoteProject)
    // JSON drops `existingId: undefined`, the way the table was written.
    expect(JSON.parse(JSON.stringify(plan))).toEqual(expected)
  })
})
