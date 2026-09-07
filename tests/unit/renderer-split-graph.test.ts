import { describe, expect, it } from 'vitest'
// @ts-expect-error Node ESM helper intentionally has no generated declaration.
import {
  assertDisjointLocalClosures,
  localJsDependencies
} from '../../scripts/renderer-split-graph.mjs'

describe('renderer recovery dependency graph', () => {
  it('discovers static and dynamic local JS edges but ignores external/nonlocal imports', () => {
    const source = `
      import { a } from "./static-a.js";
      import "./static-b.js";
      const c = import("./dynamic-c.js");
      import("pkg"); import("https://example.test/external.js"); import("../parent.js");
    `
    expect(localJsDependencies(source)).toEqual([
      'static-a.js',
      'static-b.js',
      'dynamic-c.js'
    ])
  })

  it('rejects retry graphs that converge through a shared dynamic child', async () => {
    const sources = new Map([
      ['primary.js', 'export const load = () => import("./shared.js")'],
      ['recovery.js', 'import("./recovery-child.js")'],
      ['recovery-child.js', 'export { shared } from "./shared.js"'],
      ['shared.js', 'export const shared = true'],
      ['entry.js', 'export const shell = true']
    ])
    await expect(assertDisjointLocalClosures({
      name: 'Fixture',
      roots: ['primary.js', 'recovery.js'],
      entryFile: 'entry.js',
      files: [...sources.keys()],
      readSource: async (file: string) => sources.get(file) ?? ''
    })).rejects.toThrow('intersect at shared.js')
  })

  it('rejects a non-literal dynamic edge whose local closure cannot be proven', () => {
    expect(() => localJsDependencies('const child = import("./" + chunkName + ".js")'))
      .toThrow('non-literal dynamic import')
  })

  it('accepts recursively disjoint retry graphs and excludes the eager entry', async () => {
    const sources = new Map([
      ['primary.js', 'import "./entry.js"; import("./primary-child.js")'],
      ['primary-child.js', 'export const primary = true'],
      ['recovery.js', 'import "./entry.js"; import("./recovery-child.js")'],
      ['recovery-child.js', 'export const recovery = true'],
      // Entry dynamic routes must not be traversed back into either closure.
      ['entry.js', 'import("./primary-child.js"); import("./recovery-child.js")']
    ])
    await expect(assertDisjointLocalClosures({
      name: 'Fixture',
      roots: ['primary.js', 'recovery.js'],
      entryFile: 'entry.js',
      files: [...sources.keys()],
      readSource: async (file: string) => sources.get(file) ?? ''
    })).resolves.toBeUndefined()
  })
})
