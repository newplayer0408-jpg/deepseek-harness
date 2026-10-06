/**
 * Product wiring for the shell-owned Community Diagnostics window.
 *
 * The engine (`community-diagnostics.ts`) collects, the window
 * (`community-diagnostics-window.ts`) presents, and this module is the only place that knows how to
 * get from one to the other: it supplies the real filesystem, the real runtime paths, the real Host
 * facts, and the shell's own copy, then hands back a window the application menu can open.
 *
 * It exists as a separate module for two reasons. `main.ts` is the repository's longest-lived merge
 * conflict, so the whole feature is wired through one constructor call and one click handler rather
 * than through logic that would have to live beside it; and every fact below is deliberately a live
 * read, so the diagnostics describe the process that is running rather than what packaging intended.
 *
 * Two facts are reported as *absent* rather than as *healthy*, because the shell has no way to
 * establish them: provider counts and model identity come from Host RPC this shell does not
 * implement. The only provider-shaped fact available here is whether a credential is stored, which is
 * a configuration answer a user can act on; "reachable" or "healthy" would be invented.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { release as osRelease } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard } from 'electron'
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { CommunityVersionIdentity } from './community-version.ts'
import { DESKTOP_COMMUNITY_VARIANT } from './desktop-variant.ts'
import {
  collectCommunityDiagnostics,
  type CommunityDiagnosticId,
  type CommunityDiagnosticsEntry,
  type CommunityDiagnosticsFs,
  type CommunityDiagnosticsInput,
  type CommunityDiagnosticsUpdateFacts,
  type CommunityDiagnosticsView,
} from './community-diagnostics.ts'
import {
  COMMUNITY_DIAGNOSTICS_PRELOAD,
  COMMUNITY_DIAGNOSTICS_WINDOW_SIZE,
  type CommunityDiagnosticsCopy,
} from './community-diagnostics-ipc.ts'
import {
  DesktopCommunityDiagnosticsWindow,
  type CommunityDiagnosticsWindowHandle,
} from './community-diagnostics-window.ts'
import { DESKTOP_RUNTIME_FILE } from './runtime-tree.ts'
import type { DesktopLocale, DesktopMessages } from './locale.ts'

/** Runtime locations the diagnostics probe, taken from the shell's own resolved tree. */
export interface CommunityDiagnosticsRuntimePaths {
  /** Bundled dsh tree the Host is launched from. */
  readonly dsh: string
  /** Directory holding the Node launcher the Host runs under. */
  readonly nodeBin: string
  /** Bundled pnpm entry the shell runs package operations with. */
  readonly pnpm: string
  /** Immutable primary runtime directory shipped beside the application. */
  readonly primary: string
}

/**
 * Everything the product wiring needs from its owner.
 *
 * Window policy, IPC guards, redaction, and copy selection all stay inside the modules below; this
 * seam carries only the facts and the two Host readers the shell already owns.
 */
export interface DesktopCommunityDiagnosticsOptions {
  /** Shell locale reader; the window renders in the language current when it collects. */
  readonly locale: () => DesktopLocale
  /** The fork's version facts, or undefined on a build that read none. */
  readonly community: CommunityVersionIdentity | undefined
  /**
   * The Community update surface, when this build wired one.
   *
   * It is a reader rather than a value because the update state changes while the application runs,
   * and a report collected after a check must describe the state that check produced.
   * @returns the update facts, or undefined when no update service exists.
   */
  readonly update: () => CommunityDiagnosticsUpdateFacts | undefined
  /** Runtime locations to probe. */
  readonly runtime: CommunityDiagnosticsRuntimePaths
  /** Backend phase at the moment of collection. */
  readonly backend: () => 'starting' | 'ready' | 'error'
  /**
   * One bounded round trip against the running Host.
   *
   * It must reject when the Host cannot answer, so a stale child is reported rather than trusted.
   * @returns a promise that settles once the Host has answered.
   */
  readonly readHost: () => Promise<void>
  /**
   * Whether a model credential is stored.
   *
   * The only provider-shaped fact the shell can establish, and the only one the report claims.
   * @returns whether a configuration is present, or undefined when it cannot be read.
   */
  readonly modelConfigured: () => Promise<boolean | undefined>
  /** Application path holding the manifest; defaults to the running application. */
  readonly appPath?: string
  /** Harness home to probe; defaults to the resolved home of this process. */
  readonly home?: string
  /** Filesystem seam; a test supplies a literal listing instead of touching the machine. */
  readonly fs?: CommunityDiagnosticsFs
  /** Timestamp source for the report header. */
  readonly clock?: () => Date
}

/**
 * Whether the assembled manifest declares a mandatory-update policy.
 *
 * Read from the manifest rather than from the shell's own state, because the field is what *builds*
 * the policy client: a build that declares none has no policy service at all, which is the fact the
 * updates check reports. An unreadable manifest answers `false`, which is the state a community build
 * is in anyway.
 * @param appPath - application path holding the manifest.
 * @returns whether a policy is declared.
 */
async function declaredPolicy(appPath: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(appPath, 'package.json'), 'utf8'))
    return typeof manifest === 'object' && manifest !== null && 'dshMandatoryUpdatePolicy' in manifest
  } catch {
    return false
  }
}

/**
 * Whether the packaged application carries an official update feed.
 *
 * This is the update coordinator's own admission predicate, so the report and the updater cannot
 * disagree about whether this installation can check for updates. A community build answers `false`
 * by construction: no feed is packaged beside it.
 * @returns whether an update feed file sits beside the application.
 */
function hasUpdateFeed(): boolean {
  return app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
}

/**
 * Build the real filesystem seam.
 *
 * `kind` answers `absent` only for an entry that is really not there and `unreadable` for a probe
 * that failed, which is the distinction the engine's data-directory and packaged-file checks depend
 * on. The write probe creates and removes one uniquely named file, and a removal that fails is left
 * as a leftover rather than reported as a refusal — the write already proved what it was asked to.
 * @returns the filesystem seam the collector probes.
 */
function nodeFs(): CommunityDiagnosticsFs {
  return {
    kind: (path: string): CommunityDiagnosticsEntry => {
      try {
        const entry = statSync(path, { throwIfNoEntry: false })
        if (entry === undefined) return 'absent'
        return entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
      } catch {
        return 'unreadable'
      }
    },
    probeWritableDirectory: async (directory: string): Promise<boolean> => {
      const probe = join(directory, `.dsh-diagnostics-${randomUUID()}.tmp`)
      try {
        await writeFile(probe, '')
      } catch {
        return false
      }
      try {
        await unlink(probe)
      } catch { /* A leftover probe file is not a refused write. */ }
      return true
    },
  }
}

/**
 * One label per check id, in the language the window is showing.
 * @param messages - the selected shell dictionary.
 * @returns the row labels the document renders beside each check.
 */
function rowLabels(messages: DesktopMessages): Readonly<Record<CommunityDiagnosticId, string>> {
  return {
    'community-edition': messages.diagnosticsRowCommunityEdition,
    'application-version': messages.diagnosticsRowApplicationVersion,
    'data-directory': messages.diagnosticsRowDataDirectory,
    'packaged-runtime': messages.diagnosticsRowPackagedRuntime,
    'packaged-files': messages.diagnosticsRowPackagedFiles,
    backend: messages.diagnosticsRowBackend,
    'provider-configuration': messages.diagnosticsRowProviderConfiguration,
    'model-configuration': messages.diagnosticsRowModelConfiguration,
    updates: messages.diagnosticsRowUpdates,
    telemetry: messages.diagnosticsRowTelemetry,
    system: messages.diagnosticsRowSystem,
    'community-version': messages.diagnosticsRowCommunityVersion,
    'upstream-base': messages.diagnosticsRowUpstreamBase,
    'upstream-commit': messages.diagnosticsRowUpstreamCommit,
    'community-update-source': messages.diagnosticsRowUpdateSource,
    'community-update-channel': messages.diagnosticsRowUpdateChannel,
    'community-update-last-check': messages.diagnosticsRowUpdateLastCheck,
    'community-update-latest': messages.diagnosticsRowUpdateLatest,
    'community-update-manifest': messages.diagnosticsRowUpdateManifest,
    'community-update-download': messages.diagnosticsRowUpdateDownload,
    'community-update-checksum': messages.diagnosticsRowUpdateChecksum,
  }
}

/**
 * The shell's copy for one diagnostics presentation.
 *
 * Every word comes from the locale the shell already owns, so the document hard-codes nothing and the
 * window can be re-collected in a new language without a reload.
 * @param locale - the locale current when the presentation is built.
 * @returns the copy the window attaches to the collected checks.
 */
export function communityDiagnosticsCopy(locale: DesktopLocale): CommunityDiagnosticsCopy {
  const { messages } = locale
  return {
    locale: locale.id,
    title: messages.diagnosticsTitle,
    refresh: messages.diagnosticsRefresh,
    copyReport: messages.diagnosticsCopyReport,
    copied: messages.diagnosticsCopied,
    unavailable: messages.diagnosticsUnavailable,
    summary: {
      pass: messages.diagnosticsSummaryPass,
      warn: messages.diagnosticsSummaryWarn,
      fail: messages.diagnosticsSummaryFail,
      info: messages.diagnosticsSummaryInfo,
    },
    rows: rowLabels(messages),
  }
}

/**
 * Assemble one collection input from live process facts.
 * @param options - the wiring's injected facts and readers.
 * @param fs - the filesystem seam to probe with.
 * @returns the input the collector turns into a view.
 */
async function diagnosticsInput(
  options: DesktopCommunityDiagnosticsOptions,
  fs: CommunityDiagnosticsFs,
): Promise<CommunityDiagnosticsInput> {
  const appPath = options.appPath ?? app.getAppPath()
  const home = options.home ?? resolveDshHome()
  const phase = options.backend()
  const feed = hasUpdateFeed()
  const update = options.update()
  return {
    variant: DESKTOP_COMMUNITY_VARIANT,
    ...options.community === undefined ? {} : {
      communityVersion: options.community.version,
      upstreamBase: options.community.upstreamBase,
      ...options.community.upstreamCommit === undefined ? {} : { upstreamCommit: options.community.upstreamCommit },
    },
    ...update === undefined ? {} : { update },
    appVersion: app.getVersion(),
    locale: app.getLocale(),
    paths: { home, homeDisplay: dshHomeDisplay(home) },
    resources: {
      runtime: {
        descriptor: join(options.runtime.dsh, DESKTOP_RUNTIME_FILE),
        primary: options.runtime.primary,
        read: async () => {
          const descriptor: unknown = JSON.parse(await readFile(join(options.runtime.dsh, DESKTOP_RUNTIME_FILE), 'utf8'))
          const release = (descriptor as { release?: { version?: unknown } }).release
          return typeof release?.version === 'string' ? release.version : undefined
        },
      },
      files: [
        { label: 'runtime-bin', path: options.runtime.nodeBin, kind: 'directory' },
        { label: 'pnpm', path: options.runtime.pnpm, kind: 'file' },
        {
          label: 'host-entry',
          path: join(options.runtime.dsh, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
          kind: 'file',
        },
      ],
    },
    backend: {
      phase,
      ...phase !== 'ready' ? {} : { probe: async () => { await options.readHost(); return true } },
    },
    // The shell implements no provider RPC, so the counts stay unavailable rather than guessed. The
    // one provider-shaped fact it does own — a stored credential — is reported as model presence.
    rpc: {
      models: async () => await options.modelConfigured(),
    },
    updates: { mandatoryPolicy: await declaredPolicy(appPath), feed, enabled: feed },
    // The community bootstrap is what seeds both values, so a community installation that reports a
    // disabled mode reports the build's own default. An operator who set either one keeps it, and the
    // check still reports the fact honestly; only the "by default" wording depends on this flag.
    telemetry: {
      mode: process.env.DSH_TELEMETRY_MODE,
      seededByVariant: process.env.DSH_TELEMETRY_MODE === 'DISABLED' && process.env.DSH_TELEMETRY_DISABLED === 'DISABLED',
    },
    platform: { os: process.platform, release: osRelease(), arch: process.arch },
    versions: { electron: process.versions.electron ?? '', node: process.versions.node ?? '' },
    fs,
    clock: options.clock ?? (() => new Date()),
  }
}

/**
 * Create the Community Diagnostics window the application menu opens.
 *
 * The returned window owns its IPC handlers from construction, so a build that never opens the
 * diagnostics still answers only its own document — and a build that does not call this at all
 * registers nothing. The caller disposes it during shutdown, beside the shell's other update and
 * window teardown, rather than this module reaching into the application lifecycle.
 * @param options - the wiring's injected facts and readers.
 * @returns the window to open and dispose.
 */
export function createDesktopCommunityDiagnostics(
  options: DesktopCommunityDiagnosticsOptions,
): DesktopCommunityDiagnosticsWindow {
  const fs = options.fs ?? nodeFs()
  return new DesktopCommunityDiagnosticsWindow({
    preload: COMMUNITY_DIAGNOSTICS_PRELOAD,
    createWindow: (preload: string, title: string): CommunityDiagnosticsWindowHandle => {
      const created = new BrowserWindow({
        width: COMMUNITY_DIAGNOSTICS_WINDOW_SIZE.width,
        height: COMMUNITY_DIAGNOSTICS_WINDOW_SIZE.height,
        title,
        show: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        webPreferences: {
          preload,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          devTools: true,
        },
      })
      // Showing before the document paints would flash an empty frame; nothing else needs the window.
      created.once('ready-to-show', () => { if (!created.isDestroyed()) created.show() })
      return created
    },
    readDiagnostics: async (): Promise<CommunityDiagnosticsView> => await collectCommunityDiagnostics(await diagnosticsInput(options, fs)),
    copy: () => communityDiagnosticsCopy(options.locale()),
    writeReport: (report: string) => { clipboard.writeText(report) },
  })
}
