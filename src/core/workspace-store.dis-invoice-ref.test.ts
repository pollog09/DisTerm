import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { testTmpDir } from './test-tmp'
import type { Project, Workspace } from '../shared/types'

const REF = { taskId: 101, columnaId: 2, textHash: 'a1b2c3', finished: true as const }

const sticky = {
  id: 'sticky-1',
  kind: 'sticky' as const,
  position: { x: 0, y: 0 },
  size: { width: 1, height: 1 },
  title: 'Note',
  color: '#fff',
  group: null,
  text: 'Migrar el DNS',
  disInvoiceRef: REF
}

const project = (over: Partial<Project>): Project => ({
  id: 'p1',
  name: 'Exotic',
  color: '#7aa2f7',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [sticky],
  ...over
})

const ws = (p: Project): Workspace => ({ version: 2, activeProjectId: p.id, projects: [p] })

describe('the core store keeps a sticky’s disInvoiceRef verbatim', () => {
  let userData: string
  let folder: string

  beforeEach(() => {
    userData = testTmpDir('dis-store-data-')
    folder = testTmpDir('dis-store-folder-')
    initPlatform(fakePlatform({ userDataDir: userData }))
  })

  afterEach(() => resetPlatformForTests())

  const reload = async (): Promise<Project> => (await new WorkspaceStore().load()).projects[0]

  it('in a project kept in app data, and writes no task text into the folder', async () => {
    await new WorkspaceStore().save(ws(project({ cwd: folder, storeInAppData: true })))
    expect((await reload()).nodes[0].disInvoiceRef).toEqual(REF)
    await expect(fs.access(path.join(folder, '.nodeterm', 'project.json'))).rejects.toThrow()
  })

  it('in a folder-backed project', async () => {
    await new WorkspaceStore().save(ws(project({ cwd: folder })))
    expect((await reload()).nodes[0].disInvoiceRef).toEqual(REF)
    const file = JSON.parse(await fs.readFile(path.join(folder, '.nodeterm', 'project.json'), 'utf8'))
    expect(file.nodes[0].disInvoiceRef).toEqual(REF)
  })
})
