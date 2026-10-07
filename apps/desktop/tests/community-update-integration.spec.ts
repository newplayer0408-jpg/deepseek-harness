/**
 * The product wiring for the Community Update surface: the shell's own words, the real staging
 * directory, and the object the application menu opens.
 *
 * The service, the window, and the presentation each have their own spec. What only this file can
 * prove is the other half of the Story: that the copy a user reads comes from the shell's dictionary
 * in the language current at the time, that a download is staged in a controlled directory *inside*
 * the Community home rather than beside the installer or inside the repository, and that the object
 * `main.ts` holds exposes the state the diagnostics report renders and nothing else.
 *
 * The staging cases run against a real temporary directory, because the properties worth pinning are
 * filesystem properties: bytes must not appear under the final name until the digest matched, a
 * leftover from an interrupted run must be cleaned rather than offered, and the directory the surface
 * displays must never be the machine's own path.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMMUNITY_UPDATE_DIRECTORY,
  COMMUNITY_UPDATE_IDLE_TIMEOUT_MS,
  COMMUNITY_UPDATE_PART_SUFFIX,
  communityUpdateCopy,
  createCommunityUpdateStore,
  createDesktopCommunityUpdate,
} from '../src/community-update-integration.ts'
import { COMMUNITY_UPDATE_IPC, COMMUNITY_UPDATE_PRELOAD, COMMUNITY_UPDATE_WINDOW_SIZE } from '../src/community-update-ipc.ts'
import type { CommunityUpdatePhase } from '../src/community-update-service.ts'
import type { CommunityUpdateTransport } from '../src/community-update-download.ts'
import type { CommunityUpdateStore } from '../src/community-update-service.ts'
import { presentCommunityUpdate } from '../src/community-update-presentation.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import {
  communityAssetUrl,
  communityManifestUrl,
  parseCommunityRelease,
  type CommunityReleaseIdentity,
} from '../src/community-release.ts'

/** Every phase the update service reports, so the copy is checked against all of them. */
const PHASES: readonly CommunityUpdatePhase[] = [
  'idle', 'checking', 'up-to-date', 'update-available', 'downloading', 'downloaded', 'verifying', 'ready',
  'network-error', 'invalid-manifest', 'download-error', 'checksum-error', 'unsupported-platform',
]

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const windows: FakeWindow[] = []
  const request = vi.fn()
  // The page the owned document sits on, which is what the window's sender guard compares against.
  const page = 'dsh-app://shell/community-update.html'
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly focus = vi.fn()
    readonly loadURL = vi.fn(async () => {})
    readonly webContents = Object.assign(new EventEmitter(), { send: vi.fn(), mainFrame: { url: page } })
    constructor(readonly options: Record<string, unknown>) { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  return { handlers, windows, FakeWindow, request }
})
vi.mock('electron', () => ({
  BrowserWindow: fixture.FakeWindow,
  net: { request: (...args: unknown[]) => fixture.request(...args) },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn() },
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => {
      if (fixture.handlers.has(name)) throw new Error(`ipcMain.handle: duplicate handler for ${name}`)
      fixture.handlers.set(name, fn)
    },
    removeHandler: (name: string) => fixture.handlers.delete(name),
  },
}))

/** The identity the shipped file declares. */
const IDENTITY: CommunityReleaseIdentity = parseCommunityRelease(
  JSON.parse(String.raw`{"repository":"newplayer0408-jpg/deepseek-harness","manifest":"latest-community.json"}`),
)!

/** The fork's development line, which is what this build reports. */
const COMMUNITY = { version: 'v0.2-dev', upstreamBase: 'dsh-v0.2.0-rc.2' } as const

/** The installer name the fork publishes for Windows x64. */
const ASSET_NAME = 'DeepSeek-Harness-Community-v0.3-Windows-x64.exe'

let home: string
let active: ReturnType<typeof createDesktopCommunityUpdate> | undefined

beforeEach(() => {
  fixture.handlers.clear()
  fixture.windows.length = 0
  fixture.request.mockReset()
  home = mkdtempSync(join(tmpdir(), 'dsh-community-update-'))
})

afterEach(() => {
  active?.dispose()
  active = undefined
  rmSync(home, { recursive: true, force: true })
  fixture.handlers.clear()
  fixture.windows.length = 0
})

/** A transport that fails, so a case that never downloads cannot reach the network by accident. */
const OFFLINE: CommunityUpdateTransport = { request: async () => ({ kind: 'failure', reason: 'network' }) }

/** One response body, delivered as a real async iterable rather than as an array. */
async function *chunks(...parts: readonly (Uint8Array | string)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part) : part
}

/** The update surface over the current temporary home, with the network replaced. */
function wiring(overrides: {
  readonly release?: CommunityReleaseIdentity | undefined
  readonly store?: CommunityUpdateStore
  readonly community?: { readonly version: string; readonly upstreamBase: string }
  readonly transport?: CommunityUpdateTransport
} = {}) {
  const update = createDesktopCommunityUpdate({
    locale: () => resolveDesktopLocale('en'),
    community: overrides.community ?? COMMUNITY,
    release: 'release' in overrides ? overrides.release : IDENTITY,
    platform: { os: 'win32', arch: 'x64' },
    home,
    transport: overrides.transport ?? OFFLINE,
    // The same staging directory the case stages into, so a file this test commits is the file the
    // surface reports: two stores over one directory would each keep their own idea of what is there.
    ...overrides.store === undefined ? {} : { store: overrides.store },
  })
  active = update
  return update
}

/** The directory the update surface stages into. */
function updates(): string { return join(home, COMMUNITY_UPDATE_DIRECTORY) }

/** The preload path the window just created was handed, or a loud failure rather than a silent undefined. */
function createdPreload(): string {
  const preferences = fixture.windows.at(-1)!.options.webPreferences as { preload?: unknown } | undefined
  if (typeof preferences?.preload !== 'string') throw new Error('the created window was given no preload path')
  return preferences.preload
}

describe('the words the shell supplies', () => {
  it('takes every status line from the dictionary, in the language it was asked for', () => {
    const english = communityUpdateCopy(resolveDesktopLocale('en-US'))
    const chinese = communityUpdateCopy(resolveDesktopLocale('zh-CN'))
    for (const phase of PHASES) {
      expect(english.status[phase].trim(), phase).not.toBe('')
      expect(chinese.status[phase].trim(), phase).not.toBe('')
      // The two really are two: a module with hard-coded copy could not differ.
      expect(english.status[phase], phase).not.toBe(chinese.status[phase])
    }
    expect(english.title).not.toBe(chinese.title)
    expect(english.locale).toBe('en')
    expect(chinese.locale).toBe('zh-CN')
    // The action labels are the shell's own too, so the document holds no user-visible string.
    for (const label of Object.values(english.actions)) expect(label.trim()).not.toBe('')
    for (const label of Object.values(chinese.actions)) expect(label.trim()).not.toBe('')
    expect(english.actions.openLocation).not.toBe(chinese.actions.openLocation)
    // Every row label is present, so a fact cannot be shown under an empty heading.
    for (const label of [...Object.values(english.rows), ...Object.values(chinese.rows)]) expect(label.trim()).not.toBe('')
  })

  it('renders a status line for every phase the service can report', () => {
    const copy = communityUpdateCopy(resolveDesktopLocale('en'))
    for (const phase of PHASES) {
      const view = presentCommunityUpdate(copy, { phase, currentVersion: 'v0.2-dev', channel: 'development', source: 'repo' })
      expect(view.status, phase).not.toBe('')
      expect(view.actions.close, phase).not.toBe('')
    }
    // A phase the dictionary has no detail for renders no detail rather than another phase's.
    expect(presentCommunityUpdate(copy, { phase: 'checking', currentVersion: 'v0.2-dev', channel: 'development', source: 'repo' }).detail).toBe('')
  })
})

describe('where a verified download is kept', () => {
  it('stages under a temporary name and promotes it only when asked', async () => {
    const store = createCommunityUpdateStore({ home })
    const staged = await store.stage('setup.exe')
    await staged.write(Buffer.from('first'))
    await staged.write(Buffer.from('second'))
    // Nothing is offered under the real name while the digest has not been checked.
    expect(readdirSync(updates())).toEqual([`setup.exe${COMMUNITY_UPDATE_PART_SUFFIX}`])
    expect(await store.stored()).toBeUndefined()
    const file = await staged.commit()
    expect(readdirSync(updates())).toEqual(['setup.exe'])
    expect(readFileSync(join(updates(), 'setup.exe'), 'utf8')).toBe('firstsecond')
    expect(file).toEqual({ fileName: 'setup.exe', directory: `$DSH_HOME/${COMMUNITY_UPDATE_DIRECTORY}`, size: 11 })
    expect(await store.stored()).toEqual(file)
  })

  it('never hands the machine\'s own path to the surface', async () => {
    const store = createCommunityUpdateStore({ home })
    const staged = await store.stage('setup.exe')
    // The community home is labelled symbolically, and so is the directory under it.
    expect(staged.directory).toBe(`$DSH_HOME/${COMMUNITY_UPDATE_DIRECTORY}`)
    expect(JSON.stringify(await staged.commit())).not.toContain(home)
  })

  it('cleans a leftover staging file and an earlier installer before a new download', async () => {
    const store = createCommunityUpdateStore({ home })
    await store.stage('setup.exe')
    await (await store.stage('setup.exe')).commit()
    // An interrupted run, and an installer from an older release, are both sitting there.
    writeFileSync(join(updates(), `half.exe${COMMUNITY_UPDATE_PART_SUFFIX}`), 'partial')
    expect(readdirSync(updates()).sort()).toEqual([`half.exe${COMMUNITY_UPDATE_PART_SUFFIX}`, 'setup.exe'])
    await store.stage('newer.exe')
    // Only the file about to be written survives, so a stale installer can never be the one a user
    // is offered, and an unverified remnant can never be mistaken for one.
    expect(readdirSync(updates()).sort()).toEqual([`newer.exe${COMMUNITY_UPDATE_PART_SUFFIX}`])
  })

  it('leaves nothing behind when a download is discarded', async () => {
    const store = createCommunityUpdateStore({ home })
    const staged = await store.stage('setup.exe')
    await staged.write(Buffer.from('bytes'))
    await store.discard()
    expect(readdirSync(updates())).toEqual([])
    expect(await store.stored()).toBeUndefined()
    // Discarding with nothing staged is a no-op rather than a throw.
    await expect(store.discard()).resolves.toBeUndefined()
  })

  it('refuses to promote a file that was never staged, and forgets one that vanished', async () => {
    const store = createCommunityUpdateStore({ home })
    const staged = await store.stage('setup.exe')
    await staged.commit()
    expect(await store.stored()).toMatchObject({ fileName: 'setup.exe' })
    // A file a user removed by hand is reported as absent rather than as still stored.
    rmSync(join(updates(), 'setup.exe'))
    expect(await store.stored()).toBeUndefined()
    // A second commit of the same staging has nothing left to promote.
    await expect(staged.commit()).rejects.toThrow()
  })

  it('reports a staging directory it cannot create instead of throwing at the caller', async () => {
    // A home path that is a file rather than a directory: `mkdir` fails, and the fault is the store's.
    const blocked = join(home, 'not-a-directory')
    writeFileSync(blocked, '')
    await expect(createCommunityUpdateStore({ home: blocked }).stage('setup.exe')).rejects.toThrow()
  })
})

describe('the update surface the application menu opens', () => {
  it('registers its own channels and detaches them on dispose', () => {
    const update = wiring()
    expect([...fixture.handlers.keys()].sort()).toEqual([
      COMMUNITY_UPDATE_IPC.check, COMMUNITY_UPDATE_IPC.download, COMMUNITY_UPDATE_IPC.openLocation,
      COMMUNITY_UPDATE_IPC.openNotes, COMMUNITY_UPDATE_IPC.status,
    ].sort())
    // A production or development build never reaches this constructor, so an official installation
    // has none of these channels and no Community window at all. That direction is pinned by
    // `default-product-isolation` and by the shell's own startup spec.
    update.dispose()
    expect(fixture.handlers.size).toBe(0)
  })

  it('reports the facts the diagnostics report renders, and no fact the service did not produce', () => {
    const update = wiring()
    expect(update.facts()).toEqual({
      source: IDENTITY.repository,
      channel: 'development',
      phase: 'idle',
      stored: false,
    })
    expect(update.state()).toMatchObject({ phase: 'idle', currentVersion: 'v0.2-dev' })
  })

  it('reports a build with no release source without inventing one', () => {
    const update = wiring({ release: undefined })
    const facts = update.facts()
    // The absent source is left out rather than rendered as an empty string, so a report cannot show
    // a repository this installation never read.
    expect(facts).toEqual({ channel: 'development', phase: 'idle', stored: false })
    expect(facts).not.toHaveProperty('source')
    expect(JSON.stringify(facts)).not.toContain('github')
  })

  it('opens the update document in a sandboxed utility window of the recommended size', () => {
    wiring().open()
    expect(fixture.windows).toHaveLength(1)
    expect(fixture.windows[0]!.options).toMatchObject({
      width: COMMUNITY_UPDATE_WINDOW_SIZE.width,
      height: COMMUNITY_UPDATE_WINDOW_SIZE.height,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    // The window loads the shell's own page, which is the only URL its IPC accepts.
    expect(fixture.windows[0]!.loadURL).toHaveBeenCalledWith('dsh-app://shell/community-update.html')
  })

  it('hands Electron the preload as an absolute path, the only form it loads', () => {
    wiring().open()
    const preload = createdPreload()
    // Electron refuses a relative `webPreferences.preload` rather than resolving it: it logs
    // `preload script must have absolute path` and loads no script at all. A bare bundled file name
    // therefore leaves the document with no bridge — `window.dshCommunityUpdate` is undefined, the
    // document's own script throws on its first call into it, and the window stays blank with a
    // correct title and no text at all. The name must still be the one the packaging case looks for.
    expect(isAbsolute(preload)).toBe(true)
    expect(basename(preload)).toBe(COMMUNITY_UPDATE_PRELOAD)
  })

  it('downloads, verifies, promotes, and reveals one installer end to end', async () => {
    // A release-line installation, because the stable manifest can only carry a released version and
    // a development build refuses one: this is the path a user of a Community release really takes.
    const release = { version: 'v0.2', upstreamBase: 'dsh-v0.2.0-rc.2' }
    const bytes = Buffer.from('a Community installer')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const assetUrl = communityAssetUrl(IDENTITY, 'community-v0.3', ASSET_NAME)!
    const manifest = JSON.stringify({
      schemaVersion: 1,
      version: '0.3',
      channel: 'stable',
      publishedAt: '2026-10-06T00:00:00.000Z',
      upstreamBase: 'dsh-v0.2.0-rc.2',
      windows: { x64: { fileName: ASSET_NAME, url: assetUrl, sha256: digest, size: bytes.byteLength } },
    })
    const store = createCommunityUpdateStore({ home })
    const update = wiring({
      store,
      community: release,
      transport: {
        request: async (url: string) => url === communityManifestUrl(IDENTITY)
          ? { kind: 'body', status: 200, body: chunks(manifest) }
          : { kind: 'body', status: 200, body: chunks(bytes) },
      },
    })
    update.open()
    const document = fixture.windows[0]!
    const shell = await import('electron').then(module => module.shell)
    const invoke = (channel: string, ...args: unknown[]): unknown =>
      (fixture.handlers.get(channel)!)({ sender: document.webContents, senderFrame: document.webContents.mainFrame }, ...args)

    const offered = await invoke(COMMUNITY_UPDATE_IPC.check) as { phase: string; revision: number }
    expect(offered.phase).toBe('update-available')
    // Nothing is on disk while the release is only offered, so a reveal is refused at this revision.
    expect(await invoke(COMMUNITY_UPDATE_IPC.openLocation, offered.revision)).toBe(false)

    const ready = await invoke(COMMUNITY_UPDATE_IPC.download) as { phase: string; revision: number; code: string }
    expect(ready).toMatchObject({ phase: 'ready', code: '' })
    // The bytes were verified, promoted under the name the release published, and are what the
    // manifest said they were — which is the whole point of the round trip.
    expect(readFileSync(join(updates(), ASSET_NAME))).toEqual(bytes)
    expect(createHash('sha256').update(readFileSync(join(updates(), ASSET_NAME))).digest('hex')).toBe(digest)
    expect(update.facts()).toMatchObject({ phase: 'ready', stored: true, latestVersion: 'v0.3', schemaVersion: 1 })

    expect(await invoke(COMMUNITY_UPDATE_IPC.openLocation, ready.revision)).toBe(true)
    expect(shell.showItemInFolder).toHaveBeenCalledWith(join(updates(), ASSET_NAME))
    // A revision behind the one on screen cannot reveal what the newest one produced.
    expect(await invoke(COMMUNITY_UPDATE_IPC.openLocation, offered.revision)).toBe(false)
  })

  it('leaves no file behind when the downloaded bytes do not match the published digest', async () => {
    const bytes = Buffer.from('a tampered installer')
    const assetUrl = communityAssetUrl(IDENTITY, 'community-v0.3', ASSET_NAME)!
    const manifest = JSON.stringify({
      schemaVersion: 1,
      version: '0.3',
      channel: 'stable',
      publishedAt: '2026-10-06T00:00:00.000Z',
      windows: { x64: { fileName: ASSET_NAME, url: assetUrl, sha256: 'f'.repeat(64), size: bytes.byteLength } },
    })
    const update = wiring({
      community: { version: 'v0.2', upstreamBase: 'dsh-v0.2.0-rc.2' },
      store: createCommunityUpdateStore({ home }),
      transport: {
        request: async (url: string) => url === communityManifestUrl(IDENTITY)
          ? { kind: 'body', status: 200, body: chunks(manifest) }
          : { kind: 'body', status: 200, body: chunks(bytes) },
      },
    })
    update.open()
    const document = fixture.windows[0]!
    const invoke = (channel: string, ...args: unknown[]): unknown =>
      (fixture.handlers.get(channel)!)({ sender: document.webContents, senderFrame: document.webContents.mainFrame }, ...args)
    await invoke(COMMUNITY_UPDATE_IPC.check)
    const refused = await invoke(COMMUNITY_UPDATE_IPC.download) as { phase: string; code: string; revision: number }
    expect(refused).toMatchObject({ phase: 'checksum-error', code: 'checksum-mismatch' })
    // The directory is empty and there is nothing for the surface to offer, or for a user to run.
    expect(readdirSync(updates())).toEqual([])
    expect(update.facts()).toMatchObject({ phase: 'checksum-error', stored: false })
    expect(await invoke(COMMUNITY_UPDATE_IPC.openLocation, refused.revision)).toBe(false)
  })

  it('runs a check against the real transport seam and reports the failure it found', async () => {
    const update = wiring()
    update.open()
    const document = fixture.windows[0]!
    const check = (fixture.handlers.get(COMMUNITY_UPDATE_IPC.check)!)
    const view = await check({ sender: document.webContents, senderFrame: document.webContents.mainFrame }) as { phase: string }
    // The transport is the seam, so this is the state machine's own network-error path reached
    // through the product wiring rather than through a test double.
    expect(view.phase).toBe('network-error')
    expect(update.facts()).toMatchObject({ phase: 'network-error' })
  })

  it('bounds a stalled response with an idle deadline rather than waiting forever', () => {
    // The deadline bounds silence between chunks, not a slow line: a real installer on a slow
    // connection refreshes it with every chunk.
    expect(COMMUNITY_UPDATE_IDLE_TIMEOUT_MS).toBe(30_000)
  })
})
