import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { IPC } from '../shared/ipc'
import { isHostOnlyChannel } from '../shared/host-control'
import { ServerPlatform } from './platform-server'
import { ServerSecretStore } from './github-control'
import { DIS_INVOICE_SECRET_FILE, registerDisInvoice } from '../core/dis-invoice/service'
import type { DisInvoiceOverrides } from '../core/dis-invoice/overrides'
import { resolveConfig } from './config'
import { DisInvoiceClient } from '../core/dis-invoice/client'
import { FAKE_CONNECTOR_KEY, fakeCard, startFakeConnector, type FakeConnector } from '../core/dis-invoice/fake-connector'
import { EDITOR_ONLY, VIEW, COMMENT } from '../core/relay/access-policy'
import { SCOPED, SCOPED_REFUSED } from '../core/relay/scoped-guest-policy'
import { testTmpDir } from '../core/test-tmp'
import { saveUpload } from '../core/uploads'

const CHANNELS = [
  IPC.disInvoiceStatus,
  IPC.disInvoiceSaveConfig,
  IPC.disInvoiceClearKey,
  IPC.disInvoiceFetch,
  IPC.disInvoiceLinks,
  IPC.disInvoiceSaveLink,
  IPC.disInvoicePlannedFolder,
  IPC.disInvoiceEnsureFolder,
  IPC.disInvoiceClone,
  IPC.disInvoiceInspectFolder,
  IPC.disInvoiceBriefPathInWsl
]

let userDataDir: string
let documentsDir: string
let fake: FakeConnector
let platform: ServerPlatform
let clones: Array<{ parent: string; url: string; dirName?: string }>
let cloneAnswer: { ok: boolean; message: string }
let wslCalls: string[][]

class TestPlatform extends ServerPlatform {
  readonly documentsDir: string
  constructor(dir: string, documents: string) {
    super({ userDataDir: dir, appVersion: '0' })
    this.documentsDir = documents
  }
}

async function call(method: string, ...args: unknown[]): Promise<unknown> {
  const response = (await platform.dispatch(1, { t: 'req', id: 1, method, args })) as {
    ok: boolean
    result?: unknown
    error?: string
  }
  if (!response.ok) throw new Error(response.error)
  return response.result
}

beforeEach(async () => {
  userDataDir = testTmpDir('dis-server-')
  documentsDir = testTmpDir('dis-documents-')
  fake = await startFakeConnector({
    seed: {
      cards: [
        fakeCard(1, { proyecto: { id: 7, nombre: 'Web', github_repo: 'owner/web' } }),
        fakeCard(2, { proyecto: { id: 8, nombre: 'web', github_repo: null } })
      ]
    }
  })
  clones = []
  wslCalls = []
  cloneAnswer = { ok: true, message: '' }
  platform = new TestPlatform(userDataDir, documentsDir)
  registerDisInvoice({
    platform,
    secret: new ServerSecretStore(userDataDir, DIS_INVOICE_SECRET_FILE),
    client: new DisInvoiceClient({ baseUrl: fake.url }),
    wslExec: async (_file, args) => {
      wslCalls.push(args)
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    },
    git: {
      clone: async (parent: string, url: string, unattended?: { dirName: string }) => {
        clones.push({ parent, url, dirName: unattended?.dirName })
        return cloneAnswer
      },
      originUrl: async () => 'git@github.com:Owner/Web.git',
      canvasExposedToGit: async () => true
    }
  })
})

afterEach(() => fake.close())

const keyFile = (): string => path.join(userDataDir, DIS_INVOICE_SECRET_FILE)

describe('the connector key', () => {
  it('is checked against the connector before it is stored', async () => {
    expect(await call(IPC.disInvoiceSaveConfig, 'disck_wrong')).toEqual({
      ok: false,
      reason: 'unauthorized',
      message: 'dis-invoice rejected the connector key. Check it in Settings.'
    })
    expect(existsSync(keyFile())).toBe(false)
    expect(await call(IPC.disInvoiceStatus)).toEqual({ hasKey: false, storage: 'restricted-file' })

    expect(await call(IPC.disInvoiceSaveConfig, `  ${FAKE_CONNECTOR_KEY}\n`)).toEqual({ ok: true })
    expect(await call(IPC.disInvoiceStatus)).toEqual({ hasKey: true, storage: 'restricted-file' })
    expect((await fs.stat(keyFile())).mode & 0o777).toBe(0o600)
    expect(fake.requests).toEqual([
      { method: 'GET', path: '/api/connector/columns' },
      { method: 'GET', path: '/api/connector/columns' }
    ])
  })

  it.each(['', '   ', 'two words', 'x'.repeat(513), 7, null])('refuses %j without a request', async (value) => {
    expect(await call(IPC.disInvoiceSaveConfig, value)).toEqual({
      ok: false,
      reason: 'invalid',
      message: 'That does not look like a connector key.'
    })
    expect(fake.requests).toEqual([])
  })

  it('never comes back out of any channel', async () => {
    await call(IPC.disInvoiceSaveConfig, FAKE_CONNECTOR_KEY)
    const answers = [
      await call(IPC.disInvoiceStatus),
      await call(IPC.disInvoiceFetch),
      await call(IPC.disInvoiceEnsureFolder, 8),
      await call(IPC.disInvoiceLinks),
      await call(IPC.disInvoiceInspectFolder, documentsDir)
    ]
    expect(answers[2]).toMatchObject({ ok: true })
    expect(JSON.stringify(answers)).not.toContain(FAKE_CONNECTOR_KEY)
    expect(readFileSync(path.join(userDataDir, 'dis-invoice-links.json'), 'utf8')).not.toContain(FAKE_CONNECTOR_KEY)
  })

  it('clears, after which a fetch says there is no key', async () => {
    await call(IPC.disInvoiceSaveConfig, FAKE_CONNECTOR_KEY)
    await call(IPC.disInvoiceClearKey)
    expect(existsSync(keyFile())).toBe(false)
    expect(await call(IPC.disInvoiceFetch)).toEqual({
      ok: false,
      reason: 'no-key',
      message: 'Add a dis-invoice connector key in Settings.'
    })
  })
})

describe('folders and clones', () => {
  const base = (): string => path.join(documentsDir, 'Distriib')

  beforeEach(async () => {
    await call(IPC.disInvoiceSaveConfig, FAKE_CONNECTOR_KEY)
  })

  it('refuses a project that is not in the last snapshot, and never takes a path from the caller', async () => {
    const refused = { ok: false, message: 'That project is not in the last sync.' }
    expect(await call(IPC.disInvoiceEnsureFolder, 7)).toEqual(refused)
    await call(IPC.disInvoiceFetch)
    expect(await call(IPC.disInvoiceEnsureFolder, 999)).toEqual(refused)
    expect(await call(IPC.disInvoiceEnsureFolder, '/etc/evil')).toEqual(refused)
    expect(await call(IPC.disInvoiceEnsureFolder, '../evil')).toEqual(refused)
    expect(await fs.readdir(documentsDir)).toEqual([])
  })

  it('says which folder a project would get while creating and reserving nothing', async () => {
    await call(IPC.disInvoiceFetch)
    expect(await call(IPC.disInvoicePlannedFolder, 7)).toBe(path.join(base(), 'Web'))
    expect(await call(IPC.disInvoicePlannedFolder, 999)).toBe(null)
    expect(existsSync(base())).toBe(false)
    expect(await call(IPC.disInvoiceLinks)).toEqual({})
    await call(IPC.disInvoiceEnsureFolder, 7)
    expect(await call(IPC.disInvoicePlannedFolder, 8)).toBe(path.join(base(), 'web (2)'))
    await call(IPC.disInvoiceSaveLink, 7, 'p-1', '/work/web')
    expect(await call(IPC.disInvoicePlannedFolder, 7)).toBe('/work/web')
  })

  it('names folders from the snapshot and keeps them across a rename upstream', async () => {
    await call(IPC.disInvoiceFetch)
    const folder = path.join(base(), 'Web')
    expect(await call(IPC.disInvoiceEnsureFolder, 7)).toEqual({ ok: true, folder, empty: true, isRepo: false })
    expect(await call(IPC.disInvoiceEnsureFolder, 8)).toEqual({
      ok: true,
      folder: path.join(base(), 'web (2)'),
      empty: true,
      isRepo: false
    })
    fake.seed({ cards: [fakeCard(1, { proyecto: { id: 7, nombre: 'Renamed', github_repo: null } })] })
    await call(IPC.disInvoiceFetch)
    expect(await call(IPC.disInvoiceEnsureFolder, 7)).toEqual({ ok: true, folder, empty: true, isRepo: false })
    expect(await call(IPC.disInvoiceLinks)).toEqual({
      7: { projectId: null, folder },
      8: { projectId: null, folder: path.join(base(), 'web (2)') }
    })
  })

  it('clones the snapshot repository into the reserved folder, removing only an empty one first', async () => {
    await call(IPC.disInvoiceFetch)
    await call(IPC.disInvoiceEnsureFolder, 7)
    const folder = path.join(base(), 'Web')
    expect(await call(IPC.disInvoiceClone, 7)).toEqual({ ok: true })
    expect(clones).toEqual([{ parent: base(), url: 'owner/web', dirName: 'Web' }])
    expect(existsSync(folder)).toBe(false)
  })

  it('leaves a non-empty folder for the clone to refuse', async () => {
    await call(IPC.disInvoiceFetch)
    await call(IPC.disInvoiceEnsureFolder, 7)
    const kept = path.join(base(), 'Web', 'mine.txt')
    await fs.writeFile(kept, 'x')
    cloneAnswer = { ok: false, message: 'Destination already exists' }
    expect(await call(IPC.disInvoiceClone, 7)).toEqual({ ok: false, message: 'Destination already exists' })
    expect(existsSync(kept)).toBe(true)
  })

  it('puts back the empty folder it removed when the clone fails, because a linked project still points there', async () => {
    await call(IPC.disInvoiceFetch)
    await call(IPC.disInvoiceEnsureFolder, 7)
    cloneAnswer = { ok: false, message: 'fatal: Could not read from remote repository.' }
    expect(await call(IPC.disInvoiceClone, 7)).toEqual({ ok: false, message: 'fatal: Could not read from remote repository.' })
    expect(existsSync(path.join(base(), 'Web'))).toBe(true)
  })

  describe('a saved link outside the base folder', () => {
    const outside = (): string => path.join(testTmpDir('dis-elsewhere-'), 'project')

    it('is not created when it is missing', async () => {
      await call(IPC.disInvoiceFetch)
      const folder = outside()
      await call(IPC.disInvoiceSaveLink, 7, 'p-1', folder)
      expect(await call(IPC.disInvoiceEnsureFolder, 7)).toEqual({ ok: false, message: `Could not read ${folder} (ENOENT).` })
      expect(existsSync(folder)).toBe(false)
    })

    it('is read as it is when it exists', async () => {
      await call(IPC.disInvoiceFetch)
      const folder = outside()
      await fs.mkdir(folder)
      await call(IPC.disInvoiceSaveLink, 7, 'p-1', folder)
      expect(await call(IPC.disInvoiceEnsureFolder, 7)).toEqual({ ok: true, folder, empty: true, isRepo: false })
    })

    it('is never removed or cloned into, even when empty', async () => {
      await call(IPC.disInvoiceFetch)
      const folder = outside()
      await fs.mkdir(folder)
      await call(IPC.disInvoiceSaveLink, 7, 'p-1', folder)
      expect(await call(IPC.disInvoiceClone, 7)).toEqual({ ok: false, message: `${folder} is outside ${base()}, so nothing was cloned.` })
      expect(existsSync(folder)).toBe(true)
      expect(clones).toEqual([])
    })

    it('a path that climbs out of the base folder counts as outside', async () => {
      await call(IPC.disInvoiceFetch)
      const folder = path.join(base(), '..', 'climbed')
      await call(IPC.disInvoiceSaveLink, 7, 'p-1', folder)
      expect(await call(IPC.disInvoiceEnsureFolder, 7)).toEqual({ ok: false, message: `Could not read ${folder} (ENOENT).` })
      expect(existsSync(path.join(documentsDir, 'climbed'))).toBe(false)
    })
  })

  it('refuses a clone for a project with no repository', async () => {
    await call(IPC.disInvoiceFetch)
    expect(await call(IPC.disInvoiceClone, 8)).toEqual({ ok: false, message: 'That project has no repository to clone.' })
    expect(clones).toEqual([])
  })

  it('records a link, and a repeat of the same link is not a write', async () => {
    await call(IPC.disInvoiceFetch)
    expect(await call(IPC.disInvoiceSaveLink, 7, 'p-1', '/work/web')).toBe(true)
    const file = path.join(userDataDir, 'dis-invoice-links.json')
    const before = (await fs.stat(file)).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await call(IPC.disInvoiceSaveLink, 7, 'p-1', '/work/web')).toBe(true)
    expect((await fs.stat(file)).mtimeMs).toBe(before)
    expect(await call(IPC.disInvoiceLinks)).toEqual({ 7: { projectId: 'p-1', folder: '/work/web' } })
    expect(await call(IPC.disInvoiceSaveLink, -1, 'p-1', '/x')).toBe(false)
    expect(await call(IPC.disInvoiceSaveLink, 7, '', '/x')).toBe(false)
  })

  it('reads a corrupt links file as no links rather than failing the sync', async () => {
    await fs.writeFile(path.join(userDataDir, 'dis-invoice-links.json'), '{not json')
    expect(await call(IPC.disInvoiceLinks)).toEqual({})
    await fs.writeFile(
      path.join(userDataDir, 'dis-invoice-links.json'),
      JSON.stringify({ 7: { projectId: 5, folder: '/x' }, 8: { projectId: 'p', folder: '/y' }, nope: { projectId: 'p', folder: '/z' } })
    )
    expect(await call(IPC.disInvoiceLinks)).toEqual({ 8: { projectId: 'p', folder: '/y' } })
  })

  it('inspects a folder through the GitHub-only origin parser', async () => {
    expect(await call(IPC.disInvoiceInspectFolder, documentsDir)).toEqual({ originRepo: 'owner/web', canvasExposed: true })
    expect(await call(IPC.disInvoiceInspectFolder, '')).toEqual({ originRepo: null, canvasExposed: false })
  })
})

describe('a brief in a distribution', () => {
  it('translates only a saved brief, never another file on the machine', async () => {
    const saved = await saveUpload(userDataDir, 'nodeterm-prompt-1.txt', Buffer.from('brief').toString('base64'))
    expect(await call(IPC.disInvoiceBriefPathInWsl, 'wsl:Ubuntu', saved)).toEqual({ ok: true, path: saved })
    expect(wslCalls).toEqual([['-d', 'Ubuntu', '--exec', 'test', '-r', saved]])

    wslCalls.length = 0
    const refused = { ok: false, message: 'That is not a saved task brief.' }
    expect(await call(IPC.disInvoiceBriefPathInWsl, 'wsl:Ubuntu', '/etc/shadow')).toEqual(refused)
    expect(await call(IPC.disInvoiceBriefPathInWsl, 'wsl:Ubuntu', path.join(userDataDir, 'dis-invoice-connector-key.json'))).toEqual(refused)
    expect(await call(IPC.disInvoiceBriefPathInWsl, 'wsl:Ubuntu', 7)).toEqual(refused)
    expect(wslCalls).toEqual([])
  })
})

describe('the connector and folder a build talks to', () => {
  const PRODUCTION = 'https://portal.distriib.com/api/connector/columns'
  const LOOPBACK = 'http://127.0.0.1:8799/api/connector'

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  async function probe(isPackaged: boolean, overrides?: DisInvoiceOverrides): Promise<{ url: string; folder: unknown }> {
    vi.stubEnv('DISTERM_DIS_INVOICE_URL', LOOPBACK)
    vi.stubEnv('DISTERM_DIS_INVOICE_DOCUMENTS', '/from-env')
    const asked: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url)
      return new Response(JSON.stringify({ columnas: [], tareas: [{ ...fakeCard(1), proyecto: { id: 7, nombre: 'Web' } }], next_cursor: null }))
    })
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerDisInvoice({
      platform: { isPackaged, userDataDir, documentsDir, handle: (channel, fn) => void handlers.set(channel, fn) },
      secret: new ServerSecretStore(userDataDir, DIS_INVOICE_SECRET_FILE),
      git: { clone: async () => ({ ok: true, message: '' }), originUrl: async () => null, canvasExposedToGit: async () => false },
      ...(overrides ? { overrides } : {})
    })
    await handlers.get(IPC.disInvoiceSaveConfig)?.(FAKE_CONNECTOR_KEY)
    await handlers.get(IPC.disInvoiceFetch)?.()
    return { url: asked[0], folder: await handlers.get(IPC.disInvoicePlannedFolder)?.(7) }
  }

  it('a packaged build ignores the environment, so the key goes only to production', async () => {
    expect(await probe(true)).toEqual({ url: PRODUCTION, folder: path.join(documentsDir, 'Distriib', 'Web') })
  })

  it('a development build honours it', async () => {
    expect(await probe(false)).toEqual({ url: `${LOOPBACK}/columns`, folder: path.join('/from-env', 'Distriib', 'Web') })
  })

  it('the proof server, which reports itself packaged, gets there only through its explicit overrides', async () => {
    expect(await probe(true, { url: 'http://localhost:9000/api/connector', documentsDir: '/proof' })).toEqual({
      url: 'http://localhost:9000/api/connector/columns',
      folder: path.join('/proof', 'Distriib', 'Web')
    })
  })

  it('an explicit override that is not loopback still cannot redirect the key', async () => {
    expect((await probe(true, { url: 'https://evil.example/api/connector' })).url).toBe(PRODUCTION)
  })

  it('a real server’s configuration never carries overrides', () => {
    const config = resolveConfig(
      { DISTERM_DIS_INVOICE_URL: LOOPBACK, DISTERM_DIS_INVOICE_DOCUMENTS: '/from-env', NODETERM_SERVER_PASSWORD: 'x' },
      ['--data-dir', userDataDir]
    )
    expect(config.disInvoice).toBeUndefined()
  })
})

describe('relay policy', () => {
  it.each(CHANNELS)('%s is refused to every relay peer', (channel) => {
    expect(isHostOnlyChannel(channel)).toBe(true)
    expect(EDITOR_ONLY.has(channel)).toBe(true)
    expect(Object.hasOwn(VIEW, channel) || Object.hasOwn(COMMENT, channel)).toBe(false)
    expect(SCOPED_REFUSED.has(channel)).toBe(true)
    expect(Object.hasOwn(SCOPED, channel)).toBe(false)
  })
})
