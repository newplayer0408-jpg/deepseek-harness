/**
 * The diagnostics window as the shell's own boundary: one document at a time, presentation and IPC
 * owned by the main process, and nothing the document sends taken on trust.
 *
 * The window is driven through a fake Electron so every branch — a foreign sender, a dead renderer,
 * a document that never loaded, a collection that threw, a read that finishes late, a stale copy —
 * is reachable without a browser process. `apps/desktop/tests/community-diagnostics-shell.spec.ts`
 * covers the other half: the document itself, and the packaging that ships it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL as FileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMMUNITY_DIAGNOSTICS_IPC,
  COMMUNITY_DIAGNOSTICS_PAGE,
  COMMUNITY_DIAGNOSTICS_PRELOAD,
  COMMUNITY_DIAGNOSTICS_WINDOW_SIZE,
  type CommunityDiagnosticsCopy,
} from '../src/community-diagnostics-ipc.ts'
import {
  DesktopCommunityDiagnosticsWindow,
  type CommunityDiagnosticsWindowSeamMatchesElectron,
} from '../src/community-diagnostics-window.ts'
import {
  COMMUNITY_DIAGNOSTIC_IDS,
  renderCommunityDiagnosticsReport,
  type CommunityDiagnosticCheck,
  type CommunityDiagnosticsView,
} from '../src/community-diagnostics.ts'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const windows: FakeWindow[] = []
  const page = 'dsh-app://shell/community-diagnostics.html'
  const exposeInMainWorld = vi.fn<(name: string, api: unknown) => void>()
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly focus = vi.fn()
    readonly loadURL = vi.fn(async () => {})
    readonly webContents = Object.assign(new EventEmitter(), { send: vi.fn(), mainFrame: { url: page } })
    constructor(readonly options: { preload: string; title: string }) { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  return { handlers, windows, FakeWindow, page, exposeInMainWorld }
})
vi.mock('electron', () => ({
  ipcMain: {
    // A real `ipcMain.handle` throws on a channel it already owns. Mirroring that here is what stops
    // a test from quietly overwriting the handlers of a window it never disposed: without it, a
    // second window would silently take over the first one's channels and the leak would read as a
    // passing test. Every test that builds a second window therefore disposes the first.
    handle: (name: string, fn: (...args: unknown[]) => unknown) => {
      if (fixture.handlers.has(name)) throw new Error(`ipcMain.handle: duplicate handler for ${name}`)
      fixture.handlers.set(name, fn)
    },
    removeHandler: (name: string) => fixture.handlers.delete(name),
  },
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => fixture.exposeInMainWorld(name, api) },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}))

/** Shell copy the harness injects, in the language a user would read. */
const COPY: CommunityDiagnosticsCopy = {
  locale: 'en',
  title: 'Community Diagnostics',
  refresh: 'Refresh',
  copyReport: 'Copy report',
  copied: 'Copied',
  unavailable: 'Diagnostics could not be collected.',
  summary: { pass: 'pass', warn: 'warning', fail: 'failure', info: 'info' },
  rows: Object.fromEntries(COMMUNITY_DIAGNOSTIC_IDS.map(id => [id, `label of ${id}`])) as CommunityDiagnosticsCopy['rows'],
}

/** One warning among passes, so the summary and a row code are both exercised. */
const CHECKS: CommunityDiagnosticCheck[] = COMMUNITY_DIAGNOSTIC_IDS.map((id, index) => ({
  id,
  state: index === 5 ? 'WARN' : 'PASS',
  value: `value of ${id}`,
  ...index === 5 ? { code: 'E-BACKEND-NOT-VERIFIED' } : {},
}))

function view(overrides: Partial<CommunityDiagnosticsView> = {}): CommunityDiagnosticsView {
  return {
    reportVersion: 1, generated: '2026-09-26T03:00:00.000Z', variant: 'community', appVersion: '0.1.7',
    bundledDsh: '0.1.7-rc.2', platform: 'win32 10.0.26100 (x64)', electron: '40.1.0', node: '22.22.2',
    locale: 'en', checks: CHECKS, ...overrides,
  }
}

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail })
  return { promise, resolve, reject }
}

/** Let every continuation already queued on the microtask queue run. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
}

type FixtureWindow = InstanceType<typeof fixture.FakeWindow>
/** One document's IPC event, with its frame replaceable to simulate another origin. */
type SenderEvent = { sender: unknown; senderFrame: unknown }

let active: DesktopCommunityDiagnosticsWindow | undefined
afterEach(() => {
  active?.dispose()
  active = undefined
  for (const window of fixture.windows) if (!window.isDestroyed()) window.destroy()
  fixture.windows.length = 0
  fixture.handlers.clear()
  fixture.exposeInMainWorld.mockClear()
  vi.unstubAllGlobals()
  vi.resetModules()
})

interface Setup {
  readonly read: ReturnType<typeof vi.fn>
  readonly write: ReturnType<typeof vi.fn>
  readonly create: ReturnType<typeof vi.fn>
  readonly diagnosticsWindow: DesktopCommunityDiagnosticsWindow
  /** The document the window most recently created. */
  document(): FixtureWindow
  /** The event that document itself sends. */
  own(): SenderEvent
  /** Invoke one diagnostics channel as that document. */
  invoke(channel: string, ...args: unknown[]): unknown
}

function setup(options: {
  read?: () => Promise<CommunityDiagnosticsView>
  loadURL?: () => Promise<void>
  copy?: CommunityDiagnosticsCopy | (() => CommunityDiagnosticsCopy)
  write?: (report: string) => Promise<void> | void
} = {}): Setup {
  const read = vi.fn(options.read ?? (() => Promise.resolve(view())))
  const write = vi.fn<(report: string) => Promise<void> | void>(options.write ?? (() => {}))
  const create = vi.fn((preload: string, title: string) => {
    const window = new fixture.FakeWindow({ preload, title })
    if (options.loadURL !== undefined) window.loadURL.mockImplementation(options.loadURL)
    // The fake satisfies `CommunityDiagnosticsWindowHandle` structurally — the same six members a
    // real `BrowserWindow` supplies — so no assertion is needed to hand it to the window.
    return window
  })
  const diagnosticsWindow = new DesktopCommunityDiagnosticsWindow({
    preload: COMMUNITY_DIAGNOSTICS_PRELOAD,
    createWindow: (preload, title) => create(preload, title),
    readDiagnostics: () => read() as Promise<CommunityDiagnosticsView>,
    copy: options.copy ?? COPY,
    // The writer's own result is returned rather than discarded, so a rejecting clipboard reaches
    // the window exactly as the shell's real one would.
    writeReport: report => write(report),
  })
  active = diagnosticsWindow
  const document = (): FixtureWindow => fixture.windows.at(-1)!
  return {
    read, write, create, diagnosticsWindow, document,
    own: () => ({ sender: document().webContents, senderFrame: document().webContents.mainFrame }),
    invoke: (channel, ...args) => {
      const event = { sender: document().webContents, senderFrame: document().webContents.mainFrame }
      return (fixture.handlers.get(channel)!)(event, ...args)
    },
  }
}

it('opens one document on the exact diagnostics page, then focuses it instead of opening another', async () => {
  const h = setup()
  expect(h.diagnosticsWindow.isOpen).toBe(false)
  h.diagnosticsWindow.open()
  const window = h.document()
  expect(fixture.windows).toHaveLength(1)
  expect(h.create).toHaveBeenCalledWith(COMMUNITY_DIAGNOSTICS_PRELOAD, COPY.title)
  expect(window.options).toEqual({ preload: COMMUNITY_DIAGNOSTICS_PRELOAD, title: COPY.title })
  expect(window.loadURL).toHaveBeenCalledWith(COMMUNITY_DIAGNOSTICS_PAGE)
  expect(h.diagnosticsWindow.isOpen).toBe(true)
  h.diagnosticsWindow.open()
  expect(fixture.windows).toHaveLength(1)
  expect(window.focus).toHaveBeenCalledOnce()
  expect(window.loadURL).toHaveBeenCalledOnce()
  await settled()
  expect(window.webContents.send).toHaveBeenCalledOnce()
})

it('denies navigation away from the owned document and admits the page itself', () => {
  const h = setup()
  h.diagnosticsWindow.open()
  const window = h.document()
  const event = { preventDefault: vi.fn() }
  window.webContents.emit('will-navigate', event, 'https://example.com')
  window.webContents.emit('will-navigate', event, 'dsh-app://shell/extra-diagnostics.html')
  expect(event.preventDefault).toHaveBeenCalledTimes(2)
  window.webContents.emit('will-navigate', event, COMMUNITY_DIAGNOSTICS_PAGE)
  expect(event.preventDefault).toHaveBeenCalledTimes(2)
})

it('answers only its own main frame on the diagnostics page, and only with the current presentation', async () => {
  const h = setup()
  h.diagnosticsWindow.open()
  await settled()
  const window = h.document()
  const published = await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.status) as Record<string, unknown>
  expect(published).toMatchObject({
    revision: 1,
    locale: 'en',
    title: COPY.title,
    refreshLabel: COPY.refresh,
    copyReportLabel: COPY.copyReport,
    copiedLabel: COPY.copied,
    summaryLabels: COPY.summary,
    unavailable: '',
    summary: { pass: 10, warn: 1, fail: 0, info: 0 },
  })
  expect(published.rows).toEqual(CHECKS.map(check => ({
    id: check.id, label: `label of ${check.id}`, state: check.state, value: check.value, code: check.code ?? '',
  })))
  // The presentation is a closed shape: the document receives no fact the window did not choose,
  // and none of the fields a raw system probe would have supplied.
  expect(Object.keys(published).sort()).toEqual(['copiedLabel', 'copyReportLabel', 'locale', 'refreshLabel',
    'revision', 'rows', 'summary', 'summaryLabels', 'title', 'unavailable'])
  const status = fixture.handlers.get(COMMUNITY_DIAGNOSTICS_IPC.status)!
  expect(() => status(h.own())).not.toThrow()
  const refused: SenderEvent[] = [
    { sender: {}, senderFrame: window.webContents.mainFrame },
    { sender: window.webContents, senderFrame: { ...window.webContents.mainFrame } },
    { sender: window.webContents, senderFrame: { url: 'https://example.com' } },
    { sender: window.webContents, senderFrame: { url: COMMUNITY_DIAGNOSTICS_PAGE } },
    { sender: window.webContents, senderFrame: window.webContents },
  ]
  for (const event of refused) expect(() => status(event)).toThrow(/unowned diagnostics renderer/u)
})

it('stops answering as soon as the window it owns is released', async () => {
  const h = setup()
  h.diagnosticsWindow.open()
  await settled()
  const window = h.document()
  const status = fixture.handlers.get(COMMUNITY_DIAGNOSTICS_IPC.status)!
  expect(status(h.own())).toMatchObject({ revision: 1 })
  h.diagnosticsWindow.close()
  expect(h.diagnosticsWindow.isOpen).toBe(false)
  expect(window.isDestroyed()).toBe(true)
  expect(() => status({ sender: window.webContents, senderFrame: window.webContents.mainFrame }))
    .toThrow(/unowned diagnostics renderer/u)
})

it('refreshes through the injected reader, numbering each published presentation', async () => {
  const h = setup()
  h.diagnosticsWindow.open()
  await settled()
  const window = h.document()
  expect(h.read).toHaveBeenCalledOnce()
  await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.refresh)
  await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.refresh)
  expect(h.read).toHaveBeenCalledTimes(3)
  expect(window.webContents.send.mock.calls.map(call => (call[1] as { revision: number }).revision)).toEqual([1, 2, 3])
  expect(await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.status)).toMatchObject({ revision: 3 })
})

it('lets the newest refresh win when a slower older read finishes last', async () => {
  const stale = deferred<CommunityDiagnosticsView>()
  const fresh = deferred<CommunityDiagnosticsView>()
  // The two collections are told apart by the values they carry, which is what a document shows.
  const collected = (value: string): CommunityDiagnosticsView => view({ checks: CHECKS.map(check => ({ ...check, value })) })
  const queued = [stale, fresh]
  let reads = 0
  const h = setup({ read: () => queued[reads++]!.promise })
  h.diagnosticsWindow.open()
  const second = h.invoke(COMMUNITY_DIAGNOSTICS_IPC.refresh) as Promise<{ rows: readonly { value: string }[] }>
  fresh.resolve(collected('collected second'))
  expect((await second).rows.map(row => row.value)).toEqual(CHECKS.map(() => 'collected second'))
  stale.resolve(collected('collected first'))
  await settled()
  const window = h.document()
  expect(window.webContents.send).toHaveBeenCalledOnce()
  expect(window.webContents.send).toHaveBeenLastCalledWith(COMMUNITY_DIAGNOSTICS_IPC.changed,
    expect.objectContaining({ revision: 1, unavailable: '', rows: expect.any(Array) }))
  expect(JSON.stringify(window.webContents.send.mock.calls)).not.toContain('collected first')
  expect(await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.status)).toMatchObject({ revision: 1 })
})

it('presents a failed collection as the shell notice, without inventing checks or leaking the exception', async () => {
  const h = setup({ read: () => Promise.reject(new Error('ENOENT: C:\\Users\\secret-user\\.dsh-community')) })
  h.diagnosticsWindow.open()
  await settled()
  const window = h.document()
  const published = await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.status) as Record<string, unknown>
  expect(published).toMatchObject({
    revision: 1, unavailable: COPY.unavailable, rows: [], summary: { pass: 0, warn: 0, fail: 0, info: 0 },
  })
  expect(JSON.stringify(published)).not.toContain('secret-user')
  expect(JSON.stringify(window.webContents.send.mock.calls)).not.toContain('secret-user')
  // The window stays usable: a later collection publishes an ordinary presentation.
  h.read.mockImplementation(() => Promise.resolve(view()))
  await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.refresh)
  expect(await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.status))
    .toMatchObject({ revision: 2, unavailable: '', rows: expect.any(Array) })
})

it('copies the report of the presentation the document names, and nothing the document supplies', async () => {
  const h = setup()
  h.diagnosticsWindow.open()
  await settled()
  const accepted = h.invoke(COMMUNITY_DIAGNOSTICS_IPC.copyReport, 1, 'sk-test-THIS-MUST-NOT-LEAK', 'Bearer token')
  expect(await accepted).toBe(true)
  expect(h.write).toHaveBeenCalledOnce()
  expect(h.write).toHaveBeenCalledWith(renderCommunityDiagnosticsReport(view()))
  expect(h.write.mock.calls[0]![0]).not.toContain('THIS-MUST-NOT-LEAK')
  expect(h.write.mock.calls[0]![0]).not.toContain('Bearer')
})

it('refuses a copy request from a stale or unknown presentation, and one with no report behind it', async () => {
  const h = setup()
  h.diagnosticsWindow.open()
  await settled()
  await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.refresh)
  for (const revision of [1, 0, 3, '2', null, undefined, { revision: 2 }]) {
    expect(await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.copyReport, revision)).toBe(false)
  }
  expect(h.write).not.toHaveBeenCalled()
  expect(await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.copyReport, 2)).toBe(true)
  expect(h.write).toHaveBeenCalledOnce()

  // The failed collection is a second window, so the first one gives up its channels first.
  h.diagnosticsWindow.dispose()
  const failing = setup({ read: () => Promise.reject(new Error('probe failed')) })
  failing.diagnosticsWindow.open()
  await settled()
  expect(await failing.invoke(COMMUNITY_DIAGNOSTICS_IPC.copyReport, 1)).toBe(false)
  expect(failing.write).not.toHaveBeenCalled()
})

it('answers a refused clipboard write as a plain refusal, without exposing the exception', async () => {
  const secret = 'sk-test-CLIPBOARD-MUST-NOT-LEAK'
  const h = setup({ write: () => Promise.reject(new Error(`clipboard unavailable while writing: ${secret}`)) })
  h.diagnosticsWindow.open()
  await settled()
  expect(await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.copyReport, 1)).toBe(false)
  // The writer was reached and its rejection was contained: the document is told only that nothing
  // was copied, and no channel here can carry the message back.
  expect(h.write).toHaveBeenCalledOnce()
  expect(JSON.stringify(h.write.mock.calls)).not.toContain(secret)
  expect(JSON.stringify(h.document().webContents.send.mock.calls)).not.toContain(secret)

  // A synchronous throw is contained the same way.
  h.write.mockImplementation(() => { throw new Error(`clipboard threw: ${secret}`) })
  expect(await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.copyReport, 1)).toBe(false)

  // The window stays usable: the next presentation and its copy both succeed.
  h.write.mockImplementation(() => {})
  await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.refresh)
  expect(await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.copyReport, 2)).toBe(true)
})

it('refuses to let a second window take over channels a live one still owns', async () => {
  const first = setup()
  first.diagnosticsWindow.open()
  await settled()
  // The fake registry is what makes this a failure rather than a silent takeover: a real
  // `ipcMain.handle` rejects a duplicate channel, so a test that forgot to dispose would leak.
  expect(() => new DesktopCommunityDiagnosticsWindow({
    preload: COMMUNITY_DIAGNOSTICS_PRELOAD,
    createWindow: () => new fixture.FakeWindow({ preload: COMMUNITY_DIAGNOSTICS_PRELOAD, title: COPY.title }),
    readDiagnostics: () => Promise.resolve(view()),
    copy: COPY,
    writeReport: () => {},
  })).toThrow(/duplicate handler for dsh-community-diagnostics:status/u)

  // Disposing the first window releases the channels, so the same construction then succeeds.
  first.diagnosticsWindow.dispose()
  const second = setup()
  second.diagnosticsWindow.open()
  await settled()
  expect(await second.invoke(COMMUNITY_DIAGNOSTICS_IPC.status)).toMatchObject({ revision: 1 })
})

it('closes safely when the renderer dies or the document never loads', async () => {
  const gone = setup()
  gone.diagnosticsWindow.open()
  const crashed = gone.document()
  crashed.webContents.emit('render-process-gone')
  expect(crashed.isDestroyed()).toBe(true)
  expect(gone.diagnosticsWindow.isOpen).toBe(false)
  // A destroyed window still owns its channels until it is disposed, so the second window below
  // would otherwise be refused by the registry.
  gone.diagnosticsWindow.dispose()

  const broken = setup({ loadURL: () => Promise.reject(new Error('ERR_FILE_NOT_FOUND')) })
  broken.diagnosticsWindow.open()
  const failed = broken.document()
  await settled()
  expect(failed.isDestroyed()).toBe(true)
  expect(broken.diagnosticsWindow.isOpen).toBe(false)
})

it('opens a fresh document after a close, and refuses IPC from the one it released', async () => {
  const h = setup()
  h.diagnosticsWindow.open()
  await settled()
  const first = h.document()
  const status = fixture.handlers.get(COMMUNITY_DIAGNOSTICS_IPC.status)!
  h.diagnosticsWindow.close()
  h.diagnosticsWindow.open()
  await settled()
  expect(fixture.windows).toHaveLength(2)
  expect(h.diagnosticsWindow.isOpen).toBe(true)
  const second = h.document()
  expect(second.loadURL).toHaveBeenCalledWith(COMMUNITY_DIAGNOSTICS_PAGE)
  expect(status(h.own())).toMatchObject({ revision: 2 })
  expect(() => status({ sender: first.webContents, senderFrame: first.webContents.mainFrame }))
    .toThrow(/unowned diagnostics renderer/u)
  expect(h.read).toHaveBeenCalledTimes(2)
})

it('detaches every private handler on disposal and stops opening or refreshing', async () => {
  const h = setup()
  h.diagnosticsWindow.open()
  await settled()
  // Three handlers are registered; `changed` is a push channel the window only sends on.
  expect([...fixture.handlers.keys()].sort()).toEqual([
    COMMUNITY_DIAGNOSTICS_IPC.copyReport, COMMUNITY_DIAGNOSTICS_IPC.refresh, COMMUNITY_DIAGNOSTICS_IPC.status,
  ].sort())
  h.diagnosticsWindow.dispose()
  expect(fixture.handlers.size).toBe(0)
  const opened = fixture.windows.length
  h.diagnosticsWindow.open()
  expect(fixture.windows).toHaveLength(opened)
  expect(await h.diagnosticsWindow.refresh()).toBeNull()
  h.diagnosticsWindow.dispose()
  expect(fixture.handlers.size).toBe(0)
})

it('reads the copy again for each presentation, so a language change reaches the document', async () => {
  let copy = COPY
  const h = setup({ copy: () => copy })
  h.diagnosticsWindow.open()
  await settled()
  expect(await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.status)).toMatchObject({ title: COPY.title, locale: 'en' })
  copy = { ...COPY, locale: 'zh-CN', title: '社区诊断' }
  await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.refresh)
  expect(await h.invoke(COMMUNITY_DIAGNOSTICS_IPC.status)).toMatchObject({ title: '社区诊断', locale: 'zh-CN' })
})

it('exposes its bridge only on the diagnostics page, with four narrow capabilities and no raw IPC', async () => {
  vi.stubGlobal('location', { href: 'https://example.com/community-diagnostics.html' })
  await import('../src/preload-community-diagnostics.ts')
  expect(fixture.exposeInMainWorld).not.toHaveBeenCalled()

  vi.resetModules()
  vi.stubGlobal('location', { href: COMMUNITY_DIAGNOSTICS_PAGE })
  await import('../src/preload-community-diagnostics.ts')
  expect(fixture.exposeInMainWorld).toHaveBeenCalledOnce()
  const [name, api] = fixture.exposeInMainWorld.mock.calls[0]!
  expect(name).toBe('dshCommunityDiagnostics')
  expect(Object.keys(api as object).sort()).toEqual(['copyReport', 'refresh', 'status', 'subscribe'])
  for (const forbidden of ['ipcRenderer', 'invoke', 'send', 'on', 'require', 'process', 'clipboard']) {
    expect(api).not.toHaveProperty(forbidden)
  }
})

it('names the page, the channels, and the presentation size the shell window should use', () => {
  expect(COMMUNITY_DIAGNOSTICS_WINDOW_SIZE).toEqual({ width: 640, height: 620 })
  expect(COMMUNITY_DIAGNOSTICS_PAGE).toBe('dsh-app://shell/community-diagnostics.html')
  expect(COMMUNITY_DIAGNOSTICS_IPC).toEqual({
    status: 'dsh-community-diagnostics:status',
    refresh: 'dsh-community-diagnostics:refresh',
    copyReport: 'dsh-community-diagnostics:copy-report',
    changed: 'dsh-community-diagnostics:changed',
  })
})

it('keeps its structural window seam satisfied by a real Electron window', () => {
  // The window drives a six-member interface rather than `BrowserWindow` itself, so this layer is
  // testable without a browser process. The assertion is the guard on that liberty: the alias below
  // resolves to `true` only while a real `BrowserWindow` still satisfies the interface, so if the
  // shell's window drifts away from what Phase 3 hands over, `true` is no longer assignable and the
  // suite stops compiling.
  const seam: CommunityDiagnosticsWindowSeamMatchesElectron = true
  expect(seam).toBe(true)
})

/**
 * Phase 2 leaves `main.ts` untouched, so the upstream packaging suite cannot discover this preload
 * by scanning the shell for `preload-*.cjs` — nothing there names it yet. These two tests are what
 * notices it going missing: one reads the build and packaging registration, the other proves the
 * preload's module graph stays inside what a sandboxed preload may load.
 */
describe('community diagnostics packaging', () => {
  const desktop = fileURLToPath(new FileURL('../', import.meta.url))
  const read = (relative: string): string => readFileSync(join(desktop, relative), 'utf8')

  it('builds a preload bundle and packages the CommonJS file it produces', async () => {
    const tsdown = read('tsdown.config.ts')
    const preloadEntries = /\(\[([^\]]*'preload-app'[\s\S]*?)\] as const\)/u.exec(tsdown)![1]!
    expect(preloadEntries).toContain("'preload-community-diagnostics'")
    // The entry name is what the sandboxed-CJS format maps onto the file the shell loads.
    expect(tsdown).toContain('entry: { [name]: `lib/types/${name}.js` }')
    expect(tsdown).not.toContain('preload-community-diagnostics.cjs')

    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const builder = createElectronBuilderConfig({
      DSH_DESKTOP_VARIANT: 'community',
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(builder.files).toContain(`lib/${COMMUNITY_DIAGNOSTICS_PRELOAD}`)
    expect(builder.files).toContain('lib/preload-app.cjs')
    // renderer/**/* already carries the page, its stylesheet, and its script.
    expect(builder.files).toContain('renderer/**/*')
    // Cold-loading electron-builder's NSIS target is the cost here, not the assertion.
  }, 60_000)

  it('reaches no bare import but electron, and no Node builtin at all, from the preload', () => {
    const contract = read('src/community-diagnostics-ipc.ts')
    const preload = read('src/preload-community-diagnostics.ts')
    // A sandboxed preload's require polyfill resolves only electron/events/timers/url, and the bundle
    // check walks every parsed module before tree-shaking, so a value import anywhere in this graph
    // would fail the bundle rather than merely enlarge it. The contract module is what keeps the probe
    // engine — and through it node:fs/promises, node:os, and node:path — out of that graph.
    expect([...contract.matchAll(/^import(?! type)/gmu)]).toHaveLength(0)
    expect([...preload.matchAll(/from '([^']+)'/gu)].map(match => match[1]))
      .toEqual(['electron', './community-diagnostics-ipc.ts'])
    expect(read('src/community-diagnostics-window.ts')).toContain("from './community-diagnostics.ts'")
  })

  it('bundles the real preload source as sandboxed CommonJS, so only electron survives as a require', async () => {
    // The two tests above read the configuration and the source text. This one runs the same bundler
    // and the same import policy the build uses, over the preload's real module graph rather than a
    // fixture, which is what proves the graph actually produces a loadable sandboxed preload instead
    // of merely looking clean: every non-relative, non-electron specifier would be reported here.
    const { Rolldown } = await import('tsdown')
    const { packagedImportsPlugin } = await import('../scripts/desktop-bundle-imports.mjs')
    const sandboxedPreload = { packages: new Set(['electron', 'events', 'timers', 'url']), nodeBuiltins: false }
    const bundle = await Rolldown.rolldown({
      input: join(desktop, 'src/preload-community-diagnostics.ts'),
      platform: 'node',
      // Only electron and Node builtins stay external, so every relative module is parsed and walked.
      external: (id: string) => id === 'electron' || id.startsWith('node:'),
      logLevel: 'silent',
      plugins: [packagedImportsPlugin(sandboxedPreload)],
    })
    try {
      const output = await bundle.generate({ format: 'cjs' })
      const chunks = output.output.filter(chunk => chunk.type === 'chunk')
      expect(chunks).toHaveLength(1)
      const code = chunks.map(chunk => chunk.code).join('')
      expect([...code.matchAll(/require\((['"])([^'"]+)\1\)/gu)].map(match => match[2])).toEqual(['electron'])
      expect(code).toContain('dshCommunityDiagnostics')
      expect(code).not.toContain('node:fs')
    } finally {
      await bundle.close()
    }
  })
})
