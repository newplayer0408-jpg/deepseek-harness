/**
 * The product wiring between the diagnostics engine and the shell's own window.
 *
 * The engine, the window, the report, and the document each have their own spec, and each of those
 * drives a seam its own test supplies. What only this file can prove is the other half: that the
 * running installation's *real* facts reach that window, and that nothing the wiring supplies escapes
 * the redaction the layers beneath it perform.
 *
 * So every case below builds a real directory tree — the app manifest, the bundled runtime
 * descriptor, the packaged entries, the Harness home — and hands it to the real constructor with the
 * real filesystem seam. Nothing is stubbed away, which is what makes a wiring regression (a fact read
 * from the wrong place, a value the shell invented) fail here rather than in the field. The tree
 * lives under the system temporary directory, so no case touches the installation it runs on.
 *
 * The assertions are made against the presentation the main process pushes to its document rather
 * than against the collector's own return value, because the presentation is what a user reads: a row
 * there carries the shell's label for a check beside the state and value the collector reported, and
 * nothing else of the view survives the boundary.
 *
 * Two facts are deliberately *absent* rather than healthy, and the cases pin that too: the shell
 * implements no provider RPC, so provider counts stay unavailable and only the one provider-shaped
 * fact it owns — a stored credential — is reported as model presence.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMMUNITY_DIAGNOSTICS_IPC,
  COMMUNITY_DIAGNOSTICS_PAGE,
  COMMUNITY_DIAGNOSTICS_PRELOAD,
  COMMUNITY_DIAGNOSTICS_WINDOW_SIZE,
  type CommunityDiagnosticsWindowView,
} from '../src/community-diagnostics-ipc.ts'
import { COMMUNITY_DIAGNOSTIC_IDS, type CommunityDiagnosticId } from '../src/community-diagnostics.ts'
import {
  communityDiagnosticsCopy,
  createDesktopCommunityDiagnostics,
  type CommunityDiagnosticsRuntimePaths,
  type DesktopCommunityDiagnosticsOptions,
} from '../src/community-diagnostics-integration.ts'
import type { DesktopCommunityDiagnosticsWindow } from '../src/community-diagnostics-window.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import { DESKTOP_RUNTIME_FILE } from '../src/runtime-tree.ts'

/**
 * A full commit hash in the shape `git rev-parse` prints, and deliberately not one that exists: the
 * check must carry it whole, so the case would fail if the wiring ever shortened it for display.
 */
const RECORDED_COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'

/** Plausible secret material, written wherever a seam might hand back something it should not. */
const SECRET = 'sk-test-THIS-MUST-NOT-LEAK'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const windows: FakeWindow[] = []
  const page = 'dsh-app://shell/community-diagnostics.html'
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly focus = vi.fn()
    readonly loadURL = vi.fn(async () => {})
    readonly webContents = Object.assign(new EventEmitter(), { send: vi.fn(), mainFrame: { url: page } })
    constructor(readonly options: Record<string, unknown>) { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  const clipboard = { writeText: vi.fn<(text: string) => void>() }
  const app = {
    packaged: true,
    get isPackaged() { return app.packaged },
    getVersion: () => '0.2.0-rc.2',
    getLocale: () => 'en-US',
    getAppPath: () => '',
  }
  return { handlers, windows, FakeWindow, page, clipboard, app }
})

vi.mock('electron', () => ({
  app: fixture.app,
  BrowserWindow: fixture.FakeWindow,
  clipboard: fixture.clipboard,
  ipcMain: {
    // A real `ipcMain.handle` refuses a channel it already owns, and mirroring that is what keeps a
    // case from silently taking over a window it never disposed.
    handle: (name: string, fn: (...args: unknown[]) => unknown) => {
      if (fixture.handlers.has(name)) throw new Error(`duplicate IPC handler ${name}`)
      fixture.handlers.set(name, fn)
    },
    removeHandler: (name: string) => fixture.handlers.delete(name),
    on: vi.fn(),
  },
}))

type FakeDocument = InstanceType<typeof fixture.FakeWindow>
type Presentation = CommunityDiagnosticsWindowView
type Row = Presentation['rows'][number]

/** The directory tree one case hands to the wiring, as a real packaged installation would look. */
interface Installation {
  readonly root: string
  readonly appPath: string
  readonly home: string
  /** The packaged resources directory, which is where an update feed would sit. */
  readonly resources: string
  readonly runtime: CommunityDiagnosticsRuntimePaths
  /** Path of the bundled runtime descriptor, for a case that wants to corrupt its contents. */
  readonly descriptor: string
}

/**
 * Build one installation on disk.
 *
 * Every entry the collector probes is created as the kind it must be, so a healthy tree really
 * passes: the wiring is exercised against the same probes a packaged build sees.
 */
function install(): Installation {
  const root = mkdtempSync(join(tmpdir(), 'dsh-diagnostics-wiring-'))
  const appPath = join(root, 'app')
  const dsh = join(root, 'dsh')
  const nodeBin = join(root, 'bin')
  const primary = join(root, 'primary')
  const home = join(root, 'home')
  const resources = join(root, 'resources')
  const hostEntryDirectory = join(dsh, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib')
  for (const directory of [appPath, nodeBin, primary, home, resources, hostEntryDirectory]) {
    mkdirSync(directory, { recursive: true })
  }
  const descriptor = join(dsh, DESKTOP_RUNTIME_FILE)
  writeFileSync(descriptor, JSON.stringify({ release: { version: '0.2.0-rc.2' } }))
  writeFileSync(join(hostEntryDirectory, 'index.js'), '')
  const pnpm = join(root, 'pnpm')
  writeFileSync(pnpm, '')
  return { root, appPath, home, resources, runtime: { dsh, nodeBin, pnpm, primary }, descriptor }
}

let active: DesktopCommunityDiagnosticsWindow | undefined
let installation: Installation | undefined

beforeEach(() => {
  fixture.handlers.clear()
  for (const window of fixture.windows) if (!window.isDestroyed()) window.destroy()
  fixture.windows.length = 0
  fixture.clipboard.writeText.mockClear()
  fixture.app.packaged = true
  installation = install()
  // A real Electron process always carries `resourcesPath`, and the wiring reads it to decide
  // whether an update feed sits beside the application. Supplying it here is what makes the case
  // exercise the packaged geometry rather than a Node process that has none.
  vi.stubGlobal('process', { ...process, resourcesPath: installation.resources })
})

afterEach(() => {
  active?.dispose()
  active = undefined
  if (installation !== undefined) rmSync(installation.root, { recursive: true, force: true })
  installation = undefined
  fixture.handlers.clear()
  fixture.windows.length = 0
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** The tree the current case is using. */
function current(): Installation {
  if (installation === undefined) throw new Error('no installation was built')
  return installation
}

/** The wiring's options for the current tree, with one fact replaceable. */
function wiring(overrides: Partial<DesktopCommunityDiagnosticsOptions> = {}): DesktopCommunityDiagnosticsOptions {
  const tree = current()
  return {
    locale: () => resolveDesktopLocale('en'),
    community: { version: 'v0.2-dev', upstreamBase: 'dsh-v0.2.0-rc.2', upstreamCommit: RECORDED_COMMIT },
    runtime: tree.runtime,
    backend: () => 'ready',
    readHost: async () => {},
    modelConfigured: async () => true,
    appPath: tree.appPath,
    home: tree.home,
    clock: () => new Date('2026-10-06T00:00:00.000Z'),
    ...overrides,
  }
}

/**
 * Open the diagnostics window for one set of options, and return the document it created.
 *
 * The first presentation is collected from real files, so the case waits for the document to receive
 * one rather than for a fixed number of turns: a probe that has not finished would otherwise be read
 * as a collection that produced nothing.
 */
async function open(options: DesktopCommunityDiagnosticsOptions): Promise<FakeDocument> {
  // One diagnostics window per process, so a case that collects twice releases the first one: a real
  // `ipcMain.handle` refuses the channels a live window still owns.
  active?.dispose()
  active = undefined
  const diagnostics = createDesktopCommunityDiagnostics(options)
  active = diagnostics
  diagnostics.open()
  await vi.waitFor(() => {
    expect(fixture.windows.at(-1)!.webContents.send).toHaveBeenCalled()
  }, { timeout: 5000 })
  return fixture.windows.at(-1)!
}

/** The presentation the main process most recently pushed to its document. */
function published(): Presentation {
  const call = fixture.windows.at(-1)!.webContents.send.mock.calls.at(-1)
  if (call === undefined) throw new Error('the document received no presentation')
  return call[1] as Presentation
}

/** Collect once through the real wiring, and return the presentation the document was shown. */
async function present(options: DesktopCommunityDiagnosticsOptions = wiring()): Promise<Presentation> {
  await open(options)
  return published()
}

/** The row carrying one check id, or a loud failure rather than a silent undefined. */
function row(presentation: Presentation, id: CommunityDiagnosticId): Row {
  const found = presentation.rows.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`the presentation is missing the ${id} row`)
  return found
}

/** Invoke one diagnostics channel as the document the window owns. */
function invokeAs(document: FakeDocument, channel: string, ...args: unknown[]): unknown {
  const handler = fixture.handlers.get(channel)
  if (handler === undefined) throw new Error(`no handler for ${channel}`)
  return handler({ sender: document.webContents, senderFrame: document.webContents.mainFrame }, ...args)
}

/** Copy the presentation the document is showing, and return the text the clipboard received. */
async function copyPresented(document: FakeDocument): Promise<string> {
  expect(await invokeAs(document, COMMUNITY_DIAGNOSTICS_IPC.copyReport, published().revision)).toBe(true)
  return fixture.clipboard.writeText.mock.calls.at(-1)![0]
}

describe('the shell copy the window presents', () => {
  it('takes every label from the shell dictionary, in the language it was asked for', () => {
    const english = communityDiagnosticsCopy(resolveDesktopLocale('en-US'))
    const chinese = communityDiagnosticsCopy(resolveDesktopLocale('zh-CN'))
    for (const id of COMMUNITY_DIAGNOSTIC_IDS) {
      expect(english.rows[id].trim()).not.toBe('')
      expect(chinese.rows[id].trim()).not.toBe('')
    }
    // The two dictionaries really are two: a module with hard-coded copy could not differ.
    expect(english.rows['packaged-runtime']).not.toBe(chinese.rows['packaged-runtime'])
    expect(english.title).not.toBe(chinese.title)
    expect(chinese.locale).toBe('zh-CN')
  })

  it('describes every check the collector can report, and no id it cannot', () => {
    const copy = communityDiagnosticsCopy(resolveDesktopLocale('en'))
    expect(Object.keys(copy.rows).sort()).toEqual([...COMMUNITY_DIAGNOSTIC_IDS].sort())
    expect(copy.summary).toEqual({ pass: 'passed', warn: 'warnings', fail: 'failures', info: 'notes' })
  })
})

describe('the window the product opens', () => {
  it('loads the diagnostics document in a sandboxed window of the recommended size', async () => {
    const document = await open(wiring())
    expect(document.loadURL).toHaveBeenCalledWith(COMMUNITY_DIAGNOSTICS_PAGE)
    expect(document.options).toMatchObject({
      width: COMMUNITY_DIAGNOSTICS_WINDOW_SIZE.width,
      height: COMMUNITY_DIAGNOSTICS_WINDOW_SIZE.height,
      // Showing before the first document paints would flash an empty frame.
      show: false,
      webPreferences: {
        preload: COMMUNITY_DIAGNOSTICS_PRELOAD,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
  })

  it('registers its own three channels and no channel of the shell', () => {
    createDesktopCommunityDiagnostics(wiring())
    expect([...fixture.handlers.keys()].sort()).toEqual([
      COMMUNITY_DIAGNOSTICS_IPC.copyReport, COMMUNITY_DIAGNOSTICS_IPC.refresh, COMMUNITY_DIAGNOSTICS_IPC.status,
    ].sort())
  })

  it('hands its own document a presentation of the running installation', async () => {
    await open(wiring())
    const document = fixture.windows.at(-1)!
    expect(document.webContents.send).toHaveBeenCalledWith(COMMUNITY_DIAGNOSTICS_IPC.changed, expect.anything())
    const presentation = published()
    expect(presentation.revision).toBe(1)
    expect(presentation.unavailable).toBe('')
    expect(presentation.locale).toBe('en')
    expect(presentation.rows.map(candidate => candidate.id)).toEqual([...COMMUNITY_DIAGNOSTIC_IDS])
    // Every row carries the shell's own label, so the document hard-codes none of them.
    expect(row(presentation, 'packaged-runtime').label).toBe('Packaged runtime')
  })

  it('answers no request from a frame that is not the document it owns', async () => {
    await open(wiring())
    const owned = fixture.windows.at(-1)!
    const handler = fixture.handlers.get(COMMUNITY_DIAGNOSTICS_IPC.status)!
    // Another frame entirely, then the shell's own application page.
    expect(() => handler({ sender: {}, senderFrame: { url: COMMUNITY_DIAGNOSTICS_PAGE } })).toThrow()
    expect(() => handler({ sender: owned.webContents, senderFrame: { url: 'dsh-app://app/index.html' } })).toThrow()
    // The document the window really owns is answered.
    expect(invokeAs(owned, COMMUNITY_DIAGNOSTICS_IPC.status)).toMatchObject({ revision: 1 })
  })
})

describe('the facts the wiring supplies', () => {
  it('reports a healthy installation as passing every check it can verify', async () => {
    const presentation = await present()
    for (const id of ['community-edition', 'data-directory', 'packaged-runtime', 'packaged-files', 'backend'] as const) {
      expect(row(presentation, id)).toMatchObject({ state: 'PASS' })
    }
  })

  it('reports the fork version, its upstream base, and the commit whole rather than shortened', async () => {
    const presentation = await present()
    expect(row(presentation, 'community-version').value).toBe('v0.2-dev')
    expect(row(presentation, 'upstream-base').value).toBe('dsh-v0.2.0-rc.2')
    // The commit is a fact about what this build packages, so nothing abbreviates it for display.
    expect(row(presentation, 'upstream-commit').value).toBe(RECORDED_COMMIT)
    expect(row(presentation, 'application-version').value).toBe('0.2.0-rc.2')
  })

  it('reads the mandatory-update policy out of the manifest the build ships', async () => {
    writeFileSync(join(current().appPath, 'package.json'),
      JSON.stringify({ dshMandatoryUpdatePolicy: { origin: 'https://policy.example.com' } }))
    const updates = row(await present(), 'updates')
    expect(updates).toMatchObject({ state: 'WARN' })
    expect(updates.value).toContain('policy service')
  })

  it('reports an installation with no policy and no feed as community-managed', async () => {
    writeFileSync(join(current().appPath, 'package.json'),
      JSON.stringify({ dshDesktopAppId: 'io.github.newplayer0408.deepseek-harness' }))
    fixture.app.packaged = false
    expect(row(await present(), 'updates')).toMatchObject({
      state: 'INFO', value: 'community-managed (no policy service, no update feed)',
    })
  })

  it('calls an update feed present exactly where the updater itself would find one', async () => {
    fixture.app.packaged = true
    expect(row(await present(), 'updates').value).toBe('community-managed (no policy service, no update feed)')
    // The same file the update coordinator admits updates by, so the two cannot disagree.
    writeFileSync(join(current().resources, 'app-update.yml'), 'provider: generic\n')
    const withFeed = row(await present(), 'updates')
    expect(withFeed).toMatchObject({ state: 'WARN' })
    expect(withFeed.value).toContain('update feed')
  })

  it('reports a stored credential as model presence without claiming a provider is reachable', async () => {
    const configured = await present(wiring({ modelConfigured: async () => true }))
    expect(row(configured, 'model-configuration')).toMatchObject({ state: 'PASS' })
    // The shell implements no provider RPC, so the count stays unavailable rather than guessed.
    expect(row(configured, 'provider-configuration')).toMatchObject({ state: 'WARN' })
    expect(row(await present(wiring({ modelConfigured: async () => false })), 'model-configuration')).toMatchObject({ state: 'WARN' })
    expect(row(await present(wiring({ modelConfigured: async () => undefined })), 'model-configuration')).toMatchObject({ state: 'WARN' })
  })

  it('reports the mode the community bootstrap seeded, and never calls an operator\'s value the default', async () => {
    vi.stubEnv('DSH_TELEMETRY_MODE', 'DISABLED')
    vi.stubEnv('DSH_TELEMETRY_DISABLED', 'DISABLED')
    expect(row(await present(), 'telemetry')).toMatchObject({ state: 'PASS', value: 'disabled by default' })
    vi.stubEnv('DSH_TELEMETRY_DISABLED', '')
    const operator = row(await present(), 'telemetry')
    expect(operator).toMatchObject({ state: 'INFO' })
    expect(operator.value).not.toContain('by default')
  })

  it('proves the backend only when the Host answers, and does not call it while starting', async () => {
    const readHost = vi.fn(async () => {})
    await present(wiring({ readHost }))
    expect(readHost).toHaveBeenCalledOnce()
    readHost.mockClear()
    const starting = await present(wiring({ backend: () => 'starting', readHost }))
    expect(row(starting, 'backend')).toMatchObject({ state: 'WARN' })
    expect(readHost).not.toHaveBeenCalled()
  })
})

describe('what the wiring cannot leak', () => {
  it('keeps a secret-shaped value out of the presentation and the copied report', async () => {
    const tree = current()
    writeFileSync(tree.descriptor, JSON.stringify({ release: { version: SECRET } }))
    const document = await open(wiring())
    const report = await copyPresented(document)
    for (const text of [JSON.stringify(published()), report]) {
      expect(text).not.toContain(SECRET)
      // No probe path reaches either surface: the home is symbolic and the entries are labels.
      expect(text).not.toContain(tree.root)
      expect(text).not.toContain(tree.home)
    }
  })

  it('writes the report of the revision the document is showing, and nothing of its own', async () => {
    const document = await open(wiring())
    // A revision the window never published copies nothing at all.
    expect(await invokeAs(document, COMMUNITY_DIAGNOSTICS_IPC.copyReport, 99)).toBe(false)
    expect(fixture.clipboard.writeText).not.toHaveBeenCalled()
    expect(await invokeAs(document, COMMUNITY_DIAGNOSTICS_IPC.copyReport, 99, SECRET)).toBe(false)
    expect(fixture.clipboard.writeText).not.toHaveBeenCalled()

    const report = await copyPresented(document)
    expect(report.startsWith('DeepSeek Harness — Community Diagnostics\n')).toBe(true)
    expect(report).toContain('variant: community')
    expect(report).toContain(`[PASS] upstream-commit ${RECORDED_COMMIT}`)
    expect(report).toContain('generated: 2026-10-06T00:00:00.000Z')
  })
})
