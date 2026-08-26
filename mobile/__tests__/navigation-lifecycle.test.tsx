import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { MultitrackEngine } from '../src/engine'
import { releaseProject, type LoadedProject } from '../src/projects'
import { closePlayerProject, PlayerRoute } from '../src/ui/RootNavigator'

jest.mock('../src/ui/CatalogScreen', () => () => null)
jest.mock('../src/ui/PlayerScreen', () => () => null)
jest.mock('../src/projects', () => ({
  ...jest.requireActual('../src/projects'),
  releaseProject: jest.fn()
}))

const project = { name: 'Test', stems: [] } as unknown as LoadedProject

test('the Player route owns the project until it actually unmounts', async () => {
  const onClosed = jest.fn()
  let renderer: ReactTestRenderer.ReactTestRenderer

  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <PlayerRoute
        engine={{} as MultitrackEngine}
        project={project}
        onBack={jest.fn()}
        onClosed={onClosed}
      />
    )
  })
  expect(onClosed).not.toHaveBeenCalled()

  await ReactTestRenderer.act(() => renderer.unmount())
  expect(onClosed).toHaveBeenCalledTimes(1)
  expect(onClosed).toHaveBeenCalledWith(project)
})

test('closing unloads the native graph before releasing its buffers', () => {
  const unload = jest.fn()
  closePlayerProject({ unload } as unknown as MultitrackEngine, project)

  expect(unload).toHaveBeenCalledTimes(1)
  expect(releaseProject).toHaveBeenCalledTimes(1)
  expect(unload.mock.invocationCallOrder[0]).toBeLessThan(
    (releaseProject as jest.Mock).mock.invocationCallOrder[0]
  )
})
