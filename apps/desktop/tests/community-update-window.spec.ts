/**
 * The Community Update window as the shell's own boundary: one document at a time, presentation and
 * IPC owned by the main process, and nothing the document sends taken on trust.
 *
 * The window performs no network read and opens no file by itself, so what these cases really pin is
 * the *refusal* surface. A sender that is not this window's own main frame on the update page is
 * rejected; a reveal is refused unless the presentation the document reports is the one that has a
 * verified download behind it; a release page is resolved from the state the shell already holds
 * rather than from anything the document supplied; and a check that finishes after a newer request
 * started never overwrites the newer result.
 *
 * The channel list is asserted as an exact set for the same reason: the document may ask for a
 * status, a check, the validated download, a reveal, and the notes page, and there is deliberately no
 * channel that accepts a URL, so a document can never direct the main process to fetch somewhere of
 * its own choosing.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL as FileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import {
  COMMUNITY_UPDATE_IPC,
  COMMUNITY_UPDATE_PAGE,
  COMMUNITY_UPDATE_PRELOAD,
  COMMUNITY_UPDATE_WINDOW_SIZE,
  type CommunityUpdateCopy,
  type CommunityUpdateWindowView,
} from '../src/community-update-ipc.ts'
import {
  DesktopCommunityUpdateWindow,
  type CommunityUpdateWindowSeamMatchesElectron,
} from '../src/community-update-window.ts'
import type { CommunityUpdateState } from '../src/community-update-service.ts'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const windows: FakeWindow[] = []
  const page = 'dsh-app://shell/community-update.html'
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly focus = vi.fn()
    readonly loadURL = vi.fn(async () => {})
    readonly webContents = Object.assign(new EventEmitter(), { send: vi.fn(), mainFrame: { url: page } })
    constructor(readonly options: { preload: string; title: string }) { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  return { handlers, windows, FakeWindow, page }
})
vi.mock('electron', () => ({
  ipcMain: {
    // A real `ipcMain.handle` refuses a channel it already owns. Mirroring that here is what keeps a
    // case from silently taking over the handlers of a window it never disposed.
    handle: (name: string, fn: (...args: unknown[]) => unknown) => {
      if (fixture.handlers.has(name)) throw new Error(`ipcMain.handle: duplicate handler for ${name}`)
      fixture.handlers.set(name, fn)
    },
    removeHandler: (name: string) => fixture.handlers.delete(name),
  },
}))

/** The phases one state can report, so the copy is complete rather than partially stubbed. */
const PHASES = [
  'idle', 'checking', 'up-to-date', 'update-available', 'downloading', 'downloaded', 'verifying', 'ready',
  'network-error', 'invalid-manifest', 'download-error', 'checksum-error', 'unsupported-platform',
] as const

/** One dictionary, with every value naming the phase it belongs to. */
const COPY: CommunityUpdateCopy = {
  locale: 'en',
  title: 'Community Update',
  status: Object.fromEntries(PHASES.map(phase => [phase, `status ${phase}`])) as CommunityUpdateCopy['status'],
  detail: {},
  rows: {
    currentVersion: 'Current version', latestVersion: 'Latest version', upstreamBase: 'Upstream base',
    publishedAt: 'Published', saveLocation: 'Saved to',
  },
  actions: {
    check: 'Check for updates', download: 'Download update', openLocation: 'Open file location',
    viewNotes: 'View release notes', close: 'Close',
  },
  progressKnown: '{received} of {total}',
  progressUnknown: '{received} so far',
}

/** A state offering a release, with the release page the manifest published. */
function offering(): CommunityUpdateState {
  return {
    phase: 'update-available',
    currentVersion: 'v0.2',
    channel: 'release',
    source: 'newplayer0408-jpg/deepseek-harness',
    latestVersion: 'v0.3',
    upstreamBase: 'dsh-v0.2.0-rc.2',
    publishedAt: '2026-10-06T00:00:00.000Z',
    releaseNotesUrl: 'https://github.com/newplayer0408-jpg/deepseek-harness/releases/tag/community-v0.3',
  }
}

/** A state with a verified installer behind it. */
function ready(): CommunityUpdateState {
  return { phase: 'ready', currentVersion: 'v0.2', channel: 'release', source: 'repo', latestVersion: 'v0.3' }
}

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Let every continuation already queued on the microtask queue run. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
}

/**
 * Assert that one channel refuses an event.
 *
 * The status channel answers synchronously and the two operations are async, so a refusal arrives as
 * a throw for one and as a rejected promise for the others. Both are the same guarantee to the
 * document, and this is what lets a case state it once.
 */
async function refuses(channel: string, event: unknown): Promise<void> {
  const handler = fixture.handlers.get(channel)!
  try {
    await handler(event)
  } catch {
    return
  }
  throw new Error(`${channel} answered a sender it does not own`)
}

type FixtureWindow = InstanceType<typeof fixture.FakeWindow>

let active: DesktopCommunityUpdateWindow | undefined
afterEach(() => {
  active?.dispose()
  active = undefined
  for (const window of fixture.windows) if (!window.isDestroyed()) window.destroy()
  fixture.windows.length = 0
  fixture.handlers.clear()
})

/** One window over replaced seams, with a document the cases can drive. */
function setup(options: {
  state?: () => CommunityUpdateState
  hasStoredFile?: () => boolean
  check?: () => Promise<CommunityUpdateState>
  download?: () => Promise<CommunityUpdateState>
  reveal?: () => Promise<boolean> | boolean
  openNotes?: (url: string) => Promise<boolean> | boolean
  copy?: CommunityUpdateCopy | (() => CommunityUpdateCopy)
  loadURL?: () => Promise<void>
} = {}) {
  const create = vi.fn((preload: string, title: string) => {
    const window = new fixture.FakeWindow({ preload, title })
    if (options.loadURL !== undefined) window.loadURL.mockImplementation(options.loadURL)
    return window
  })
  const reveal = vi.fn(options.reveal ?? (() => true))
  const openNotes = vi.fn(options.openNotes ?? (() => true))
  const updateWindow = new DesktopCommunityUpdateWindow({
    preload: COMMUNITY_UPDATE_PRELOAD,
    createWindow: (preload, title) => create(preload, title),
    readState: options.state ?? offering,
    hasStoredFile: options.hasStoredFile ?? (() => false),
    check: options.check ?? (async () => offering()),
    download: options.download ?? (async () => ready()),
    reveal: () => reveal(),
    openNotes: url => openNotes(url),
    copy: options.copy ?? COPY,
  })
  active = updateWindow
  const document = (): FixtureWindow => fixture.windows.at(-1)!
  return {
    updateWindow, create, reveal, openNotes, document,
    /** Invoke one channel as the document the window owns. */
    invoke: (channel: string, ...args: unknown[]): unknown =>
      (fixture.handlers.get(channel)!)({ sender: document().webContents, senderFrame: document().webContents.mainFrame }, ...args),
    /** The event that document itself sends. */
    own: () => ({ sender: document().webContents, senderFrame: document().webContents.mainFrame }),
  }
}

/** The presentation the document most recently received. */
function published(): CommunityUpdateWindowView {
  const call = fixture.windows.at(-1)!.webContents.send.mock.calls.at(-1)
  if (call === undefined) throw new Error('the document received no presentation')
  return call[1] as CommunityUpdateWindowView
}

it('keeps the window seam compiling against the real Electron window', () => {
  // The alias resolves to `true` only while a `BrowserWindow` satisfies the structural seam.
  const matches: CommunityUpdateWindowSeamMatchesElectron = true
  expect(matches).toBe(true)
})

it('opens one sandboxed document on the update page, then focuses it instead of opening another', async () => {
  const h = setup()
  expect(h.updateWindow.isOpen).toBe(false)
  h.updateWindow.open()
  const window = h.document()
  expect(fixture.windows).toHaveLength(1)
  expect(h.create).toHaveBeenCalledWith(COMMUNITY_UPDATE_PRELOAD, COPY.title)
  expect(window.loadURL).toHaveBeenCalledWith(COMMUNITY_UPDATE_PAGE)
  expect(h.updateWindow.isOpen).toBe(true)
  h.updateWindow.open()
  expect(fixture.windows).toHaveLength(1)
  expect(window.focus).toHaveBeenCalledOnce()
  expect(window.loadURL).toHaveBeenCalledOnce()
  await settled()
  // The document is shown the current state immediately, so it is never empty for more than a paint.
  expect(window.webContents.send).toHaveBeenCalledWith(COMMUNITY_UPDATE_IPC.changed, expect.anything())
  expect(published()).toMatchObject({ revision: 1, phase: 'update-available', status: 'status update-available' })
})

it('denies navigation away from the owned document and admits the page itself', () => {
  const h = setup()
  h.updateWindow.open()
  const window = h.document()
  const event = { preventDefault: vi.fn() }
  window.webContents.emit('will-navigate', event, 'https://example.com')
  window.webContents.emit('will-navigate', event, 'dsh-app://shell/community-diagnostics.html')
  expect(event.preventDefault).toHaveBeenCalledTimes(2)
  window.webContents.emit('will-navigate', event, COMMUNITY_UPDATE_PAGE)
  expect(event.preventDefault).toHaveBeenCalledTimes(2)
})

it('registers its own channels, and detaches every one of them when it is disposed', () => {
  const h = setup()
  expect([...fixture.handlers.keys()].sort()).toEqual([
    COMMUNITY_UPDATE_IPC.check, COMMUNITY_UPDATE_IPC.download, COMMUNITY_UPDATE_IPC.openLocation,
    COMMUNITY_UPDATE_IPC.openNotes, COMMUNITY_UPDATE_IPC.status,
  ].sort())
  h.updateWindow.dispose()
  expect(fixture.handlers.size).toBe(0)
  // A disposed window is closed too, so its document cannot keep sending to it.
  expect(h.updateWindow.isOpen).toBe(false)
  // A second dispose is a no-op rather than a throw.
  expect(() => h.updateWindow.dispose()).not.toThrow()
})

it('answers no request from a frame that is not the document it owns', async () => {
  const h = setup()
  h.updateWindow.open()
  await settled()
  const owned = h.document()
  // Before any document was shown to be the owner, and after: another frame, the shell's own
  // application page, a different `webContents`, and an event with no frame at all are refused on
  // every channel — including the two operations, whose refusal arrives as a rejection.
  for (const channel of [COMMUNITY_UPDATE_IPC.status, COMMUNITY_UPDATE_IPC.check, COMMUNITY_UPDATE_IPC.download]) {
    await refuses(channel, { sender: {}, senderFrame: { url: COMMUNITY_UPDATE_PAGE } })
    await refuses(channel, { sender: owned.webContents, senderFrame: { url: 'dsh-app://app/index.html' } })
    await refuses(channel, { sender: {}, senderFrame: owned.webContents.mainFrame })
    await refuses(channel, { sender: 'profile', senderFrame: null })
    await refuses(channel, { sender: owned.webContents, senderFrame: {} })
  }
  expect(await h.invoke(COMMUNITY_UPDATE_IPC.status)).toMatchObject({ revision: 1 })
})

it('refuses to answer anything while no document is open', async () => {
  setup()
  // With no window there is no owner at all, so every sender is unowned.
  for (const channel of [COMMUNITY_UPDATE_IPC.status, COMMUNITY_UPDATE_IPC.check, COMMUNITY_UPDATE_IPC.download]) {
    await refuses(channel, { sender: {}, senderFrame: { url: COMMUNITY_UPDATE_PAGE } })
  }
})

it('answers the current presentation, and nothing before one has been built', async () => {
  const h = setup()
  expect(h.updateWindow.isOpen).toBe(false)
  h.updateWindow.open()
  await settled()
  // The status channel is the document's own read of what it is showing.
  expect(h.invoke(COMMUNITY_UPDATE_IPC.status)).toMatchObject({ revision: 1 })
})

it('runs a check or a download through the injected operations, and publishes the result', async () => {
  const check = vi.fn(async () => offering())
  const download = vi.fn(async () => ready())
  const h = setup({ check, download })
  h.updateWindow.open()
  await settled()
  expect(await h.invoke(COMMUNITY_UPDATE_IPC.check)).toMatchObject({ phase: 'update-available', revision: 2 })
  expect(check).toHaveBeenCalledOnce()
  expect(await h.invoke(COMMUNITY_UPDATE_IPC.download)).toMatchObject({ phase: 'ready', revision: 3 })
  expect(download).toHaveBeenCalledOnce()
  expect(published()).toMatchObject({ phase: 'ready', status: 'status ready', actions: { openLocation: 'Open file location' } })
})

it('drops a result that a newer request superseded instead of overwriting it', async () => {
  const slow = deferred<CommunityUpdateState>()
  const fast = deferred<CommunityUpdateState>()
  let call = 0
  const h = setup({
    check: () => {
      call += 1
      return call === 1 ? slow.promise : fast.promise
    },
  })
  h.updateWindow.open()
  await settled()
  const first = h.invoke(COMMUNITY_UPDATE_IPC.check)
  const second = h.invoke(COMMUNITY_UPDATE_IPC.check)
  // The newer request answers first, and the older one arriving afterwards must not undo it.
  fast.resolve({ ...offering(), phase: 'up-to-date' })
  await settled()
  expect(published()).toMatchObject({ phase: 'up-to-date' })
  slow.resolve({ ...offering(), phase: 'update-available' })
  await settled()
  expect(published()).toMatchObject({ phase: 'up-to-date' })
  // Both invocations answered the presentation that is on screen, so neither saw a stale view.
  expect(await second).toMatchObject({ phase: 'up-to-date' })
  expect(await first).toMatchObject({ phase: 'up-to-date' })
})

it('keeps the last state on screen when an operation rejects, and exposes no reason', async () => {
  const error = new Error('download failed for C:\\Users\\secret\\setup.exe with token Bearer abc')
  const h = setup({ download: async () => { throw error } })
  h.updateWindow.open()
  await settled()
  expect(await h.invoke(COMMUNITY_UPDATE_IPC.download)).toMatchObject({ phase: 'update-available' })
  const shown = JSON.stringify(published())
  expect(shown).not.toContain('secret')
  expect(shown).not.toContain('Bearer')
  expect(shown).not.toContain('C:\\')
})

it('reveals the verified file only for the presentation the document reports, and only when one exists', async () => {
  let stored = true
  const h = setup({ hasStoredFile: () => stored, state: ready })
  h.updateWindow.open()
  await settled()
  const current = published().revision
  expect(await h.invoke(COMMUNITY_UPDATE_IPC.openLocation, current)).toBe(true)
  expect(h.reveal).toHaveBeenCalledOnce()
  // A revision the window never published, a revision that was superseded, and a document that sends
  // nothing at all are all refused without a reason.
  for (const revision of [0, current + 1, current - 1, '1', undefined, null, {}, [current]]) {
    expect(await h.invoke(COMMUNITY_UPDATE_IPC.openLocation, revision)).toBe(false)
  }
  // A revision that is current while no verified file exists is refused too.
  stored = false
  expect(await h.invoke(COMMUNITY_UPDATE_IPC.openLocation, current)).toBe(false)
  expect(h.reveal).toHaveBeenCalledOnce()
})

it('answers a reveal that failed as a refusal rather than as an error', async () => {
  const h = setup({ hasStoredFile: () => true, state: ready, reveal: async () => { throw new Error('EPERM: C:\\Users\\secret') } })
  h.updateWindow.open()
  await settled()
  expect(await h.invoke(COMMUNITY_UPDATE_IPC.openLocation, published().revision)).toBe(false)
})

it('opens the release page the shell resolved, and refuses when the release published none', async () => {
  const h = setup()
  h.updateWindow.open()
  await settled()
  const revision = published().revision
  expect(await h.invoke(COMMUNITY_UPDATE_IPC.openNotes, revision)).toBe(true)
  // The URL comes from the state the shell holds, never from the document: a document-supplied URL
  // is not even a parameter of the channel.
  expect(h.openNotes).toHaveBeenCalledWith(offering().releaseNotesUrl)
  expect(await h.invoke(COMMUNITY_UPDATE_IPC.openNotes, revision, 'https://evil.test/x')).toBe(true)
  expect(h.openNotes).toHaveBeenLastCalledWith(offering().releaseNotesUrl)

  // One update window per process, so the first one is released before a second is built: a real
  // `ipcMain.handle` refuses the channels a live window still owns.
  h.updateWindow.dispose()
  // A release that published no notes page: the field is absent, which is what the state carries
  // when a manifest names no release URL at all.
  const { releaseNotesUrl: _published, ...withoutNotes } = ready()
  const withoutPage = setup({ state: () => withoutNotes })
  withoutPage.updateWindow.open()
  await settled()
  expect(await withoutPage.invoke(COMMUNITY_UPDATE_IPC.openNotes, published().revision)).toBe(false)
  expect(withoutPage.openNotes).not.toHaveBeenCalled()
})

it('answers an opened notes page that failed as a refusal rather than as an error', async () => {
  const h = setup({ openNotes: async () => { throw new Error('no handler for https://evil.test') } })
  h.updateWindow.open()
  await settled()
  expect(await h.invoke(COMMUNITY_UPDATE_IPC.openNotes, published().revision)).toBe(false)
})

it('names no URL and no path in any presentation it publishes', async () => {
  const h = setup()
  h.updateWindow.open()
  await settled()
  const view = published()
  const serialized = JSON.stringify(view)
  expect(serialized).not.toContain('https://')
  expect(serialized).not.toContain(COMMUNITY_UPDATE_PAGE)
  expect(serialized).not.toContain(COMMUNITY_UPDATE_PRELOAD)
  // Every field is one the shell chose: the phases, the shell copy, and the shell's own facts.
  expect(Object.keys(view).sort()).toEqual(['actions', 'code', 'detail', 'locale', 'phase', 'revision', 'rows', 'status', 'title'])
})

it('remembers a state observed while no document was open, and shows it when one opens', async () => {
  const h = setup()
  // A check that finished before the user opened the window: reopening shows what happened rather
  // than resetting to the service's starting state.
  h.updateWindow.publish({ ...ready(), phase: 'checksum-error', fault: 'checksum-mismatch' })
  expect(fixture.windows).toHaveLength(0)
  h.updateWindow.open()
  await settled()
  expect(published()).toMatchObject({ phase: 'checksum-error', code: 'checksum-mismatch' })
})

it('closes a window that can no longer present anything, and refuses to keep sending to it', async () => {
  const h = setup()
  h.updateWindow.open()
  await settled()
  const window = h.document()
  window.webContents.emit('render-process-gone')
  expect(h.updateWindow.isOpen).toBe(false)
  expect(window.destroyed).toBe(true)
  // A closed window's channels are refused rather than answered, because it is no longer the owner.
  expect(() => (fixture.handlers.get(COMMUNITY_UPDATE_IPC.status)!)(h.own())).toThrow()
})

it('closes a document that never loaded rather than leaving an unowned shell behind', async () => {
  const h = setup({ loadURL: async () => { throw new Error('ERR_FILE_NOT_FOUND') } })
  h.updateWindow.open()
  await settled()
  expect(h.updateWindow.isOpen).toBe(false)
})

it('resolves the copy at presentation time, so a language change is reflected without reopening', async () => {
  let copy = COPY
  const h = setup({ copy: () => copy })
  h.updateWindow.open()
  await settled()
  expect(published().status).toBe('status update-available')
  copy = { ...COPY, title: 'Community 更新', status: { ...COPY.status, 'update-available': '发现新版本' } }
  h.updateWindow.publish(offering())
  expect(published()).toMatchObject({ title: 'Community 更新', status: '发现新版本' })
})

it('publishes nothing at all once it has been disposed', async () => {
  const h = setup()
  h.updateWindow.open()
  await settled()
  h.updateWindow.dispose()
  h.updateWindow.publish(ready())
  h.updateWindow.open()
  expect(fixture.windows).toHaveLength(1)
})

it('names the page, the channels, and the window size the shell should use', () => {
  expect(COMMUNITY_UPDATE_WINDOW_SIZE).toEqual({ width: 620, height: 560 })
  expect(COMMUNITY_UPDATE_PAGE).toBe('dsh-app://shell/community-update.html')
  expect(COMMUNITY_UPDATE_PRELOAD).toBe('preload-community-update.cjs')
  expect(COMMUNITY_UPDATE_IPC).toEqual({
    status: 'dsh-community-update:status',
    check: 'dsh-community-update:check',
    download: 'dsh-community-update:download',
    openLocation: 'dsh-community-update:open-location',
    openNotes: 'dsh-community-update:open-notes',
    changed: 'dsh-community-update:changed',
  })
  // Every channel is namespaced to this feature, so it cannot collide with a shell channel and
  // nothing outside this window can reach it.
  for (const channel of Object.values(COMMUNITY_UPDATE_IPC)) expect(channel).toMatch(/^dsh-community-update:/u)
})

it('builds a preload bundle and packages the document the shell loads', async () => {
  const desktop = fileURLToPath(new FileURL('..', import.meta.url))
  const read = (relative: string): string => readFileSync(join(desktop, relative), 'utf8')
  const tsdown = read('tsdown.config.ts')
  const preloadEntries = /\(\[([^\]]*'preload-app'[\s\S]*?)\] as const\)/u.exec(tsdown)![1]!
  expect(preloadEntries).toContain("'preload-community-update'")
  // The entry name is what the sandboxed-CJS format maps onto the file the shell loads, so the
  // emitted file name appears nowhere in the build configuration itself.
  expect(tsdown).toContain('entry: { [name]: `lib/types/${name}.js` }')
  expect(tsdown).not.toContain('preload-community-update.cjs')

  const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
  const builder = createElectronBuilderConfig({
    DSH_DESKTOP_VARIANT: 'community',
    DSH_DESKTOP_TARGET_PLATFORM: 'win32',
    DSH_DESKTOP_TARGET_ARCH: 'x64',
    DSH_DESKTOP_UNSIGNED: '1',
  }, 'win32', 'x64')
  // Without the preload the document has no bridge and renders nothing, so its presence in the
  // packaged file set is the second half of the same contract the window's own cases pin.
  expect(builder.files).toContain(`lib/${COMMUNITY_UPDATE_PRELOAD}`)
  // renderer/**/* already carries the page, its stylesheet, and its script.
  expect(builder.files).toContain('renderer/**/*')
  // The file set is shipped to every variant by design; it is the reader that gates on the declared
  // variant, which `community-update.spec.ts` pins for the surface table.
}, 60_000)
