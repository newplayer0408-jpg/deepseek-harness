/**
 * Product wiring for the shell-owned Community Update surface.
 *
 * The service decides, the window presents, and this module is the only place that knows how to get
 * from one to the other: it supplies the real transport, the real staging directory, the real file
 * reveal, and the shell's own copy, then hands back the window the application menu opens together
 * with the state reader the diagnostics report uses.
 *
 * It exists as a separate module for the same reasons the Community Diagnostics wiring does. `main.ts`
 * is the repository's longest-lived merge conflict, so the whole feature arrives as one constructor
 * call and one click handler; and every seam below is deliberately real, so the surface describes the
 * machine it is running on rather than what packaging intended.
 *
 * Two choices are worth naming.
 *
 * - **The transport does not follow redirects.** A release asset is served from GitHub's content host
 *   after a redirect, and the update code has to judge each hop against the declared repository. The
 *   request is therefore issued in `manual` redirect mode, which cancels the redirect unless the
 *   caller follows it, and the hop is answered to the service as data instead.
 * - **The staging directory is the Community home's, not the install directory's and not the
 *   repository's.** A verified installer therefore survives an application update, is never written
 *   somewhere a build could pick it up as an input, and is removable by the same uninstaller that
 *   owns the rest of a Community installation's state.
 */

import { mkdir, open, readdir, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, net, shell, type IncomingMessage } from 'electron'
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { DesktopLocale } from './locale.ts'
import type { CommunityVersionIdentity } from './community-version.ts'
import type { CommunityReleaseIdentity } from './community-release.ts'
import {
  DesktopCommunityUpdateWindow,
  type CommunityUpdateWindowHandle,
} from './community-update-window.ts'
import {
  COMMUNITY_UPDATE_PRELOAD,
  COMMUNITY_UPDATE_WINDOW_SIZE,
  type CommunityUpdateCopy,
} from './community-update-ipc.ts'
import {
  CommunityUpdateService,
  type CommunityUpdateStagedFile,
  type CommunityUpdateState,
  type CommunityUpdateStore,
  type CommunityUpdateStoredFile,
} from './community-update-service.ts'
import type { CommunityUpdateReply, CommunityUpdateTransport } from './community-update-download.ts'
import type { CommunityDiagnosticsUpdateFacts } from './community-diagnostics.ts'

/** Directory, inside the Community Harness home, that holds staged and verified installers. */
export const COMMUNITY_UPDATE_DIRECTORY = 'updates'

/** Suffix a download carries until its digest has been checked. */
export const COMMUNITY_UPDATE_PART_SUFFIX = '.part'

/**
 * Default silence allowed between response chunks.
 *
 * The deadline bounds a stalled connection rather than a slow one: a large installer on a slow line
 * refreshes it with every chunk, so only a genuine stall reaches it.
 */
export const COMMUNITY_UPDATE_IDLE_TIMEOUT_MS = 30_000

/** Remove one file if it is there, treating absence as success. */
async function removeIfPresent(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch { /* A path that cannot be removed is reported by whatever needs it next. */ }
}

/**
 * The real staging directory: a controlled folder inside the Community Harness home.
 *
 * Every failure a download can have is answered here rather than thrown at the caller, because each
 * one is a state the surface reports: a rejected write aborts the transfer, and a refused directory
 * becomes a failed download instead of a crashed window.
 * @param options - the Harness home to stage under, and optional seams for a test.
 * @returns the store the service stages and keeps verified installers in.
 */
export function createCommunityUpdateStore(options: {
  readonly home: string
}): CommunityUpdateStore {
  const directory = join(options.home, COMMUNITY_UPDATE_DIRECTORY)
  const display = `${dshHomeDisplay(options.home)}/${COMMUNITY_UPDATE_DIRECTORY}`
  const finalPath = (fileName: string): string => join(directory, fileName)
  const partPath = (fileName: string): string => `${finalPath(fileName)}${COMMUNITY_UPDATE_PART_SUFFIX}`
  let staged: { readonly fileName: string; readonly handle: FileHandle } | undefined
  let stored: CommunityUpdateStoredFile | undefined

  /**
   * Remove earlier attempts: every staging remnant, and any installer this run is not about to
   * write. Only this feature's own directory is touched, so nothing a user put there is at risk.
   */
  const prune = async (keep: string): Promise<void> => {
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      return
    }
    for (const entry of entries) {
      const isStagingRemnant = entry.endsWith(COMMUNITY_UPDATE_PART_SUFFIX)
      const isEarlierInstaller = entry !== keep && entry.endsWith('.exe')
      if (isStagingRemnant || isEarlierInstaller) await removeIfPresent(join(directory, entry))
    }
  }

  return {
    async stage(fileName: string): Promise<CommunityUpdateStagedFile> {
      await mkdir(directory, { recursive: true })
      await prune(fileName)
      await removeIfPresent(finalPath(fileName))
      const handle = await open(partPath(fileName), 'w')
      staged = { fileName, handle }
      return {
        fileName,
        directory: display,
        write: async (chunk: Uint8Array): Promise<void> => { await handle.write(chunk) },
        commit: async (): Promise<CommunityUpdateStoredFile> => {
          if (staged?.fileName !== fileName) throw new Error('community update: nothing staged')
          await handle.close()
          staged = undefined
          await rename(partPath(fileName), finalPath(fileName))
          const info = await stat(finalPath(fileName))
          const file: CommunityUpdateStoredFile = { fileName, directory: display, size: info.size }
          stored = file
          return file
        },
      }
    },
    async discard(): Promise<void> {
      const current = staged
      staged = undefined
      stored = undefined
      if (current !== undefined) {
        try {
          await current.handle.close()
        } catch { /* A handle that is already closed needs no second close. */ }
        await removeIfPresent(partPath(current.fileName))
      }
      await prune('')
    },
    async stored(): Promise<CommunityUpdateStoredFile | undefined> {
      const current = stored
      if (current === undefined) return undefined
      try {
        const info = await stat(finalPath(current.fileName))
        return { ...current, size: info.size }
      } catch {
        stored = undefined
        return undefined
      }
    },
  }
}

/** Turn one Electron response into an async iterable of its chunks, keeping the idle deadline alive. */
async function *responseChunks(response: IncomingMessage, keepAlive: () => void): AsyncGenerator<Uint8Array> {
  const queue: Uint8Array[] = []
  let ended = false
  let failure: unknown
  let wake: (() => void) | undefined
  response.on('data', (chunk: Buffer) => {
    queue.push(chunk)
    keepAlive()
    wake?.()
  })
  response.on('end', () => { ended = true; wake?.() })
  response.on('error', (error: Error) => { failure = error; ended = true; wake?.() })
  while (!ended || queue.length > 0) {
    const chunk = queue.shift()
    if (chunk === undefined) {
      await new Promise<void>((resolve) => { wake = resolve })
      wake = undefined
      continue
    }
    yield chunk
  }
  // A body that ended because it failed is not a body: the caller aborts and discards what it staged.
  if (failure !== undefined) throw failure
}

/**
 * The real transport, over Electron's own networking stack.
 *
 * Electron's stack rather than Node's is deliberate: it is the one the shell already uses for every
 * other request, so a user's proxy configuration and system certificate store apply to an update
 * download exactly as they do to the rest of the application.
 * @param options - optional idle deadline, in milliseconds.
 * @returns the transport the service reads and downloads through.
 */
export function createCommunityUpdateTransport(
  options: { readonly idleTimeoutMs?: number } = {},
): CommunityUpdateTransport {
  const idleTimeoutMs = options.idleTimeoutMs ?? COMMUNITY_UPDATE_IDLE_TIMEOUT_MS
  return {
    request: async (url: string, request: { readonly limit?: number } = {}): Promise<CommunityUpdateReply> => {
      return await new Promise<CommunityUpdateReply>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let received = 0
        const finish = (reply: CommunityUpdateReply): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(reply)
        }
        const call = net.request({ method: 'GET', url, redirect: 'manual' })
        const expire = (): void => {
          clearTimeout(timer)
          timer = setTimeout(() => {
            finish({ kind: 'failure', reason: 'timeout' })
            call.abort()
          }, idleTimeoutMs)
        }
        // A redirect is answered as data; the request has already been cancelled by the manual mode.
        call.on('redirect', (statusCode: number, _method: string, redirectUrl: string) => {
          finish({ kind: 'redirect', status: statusCode, location: redirectUrl })
        })
        call.on('error', () => { finish({ kind: 'failure', reason: 'network' }) })
        call.on('response', (response: IncomingMessage) => {
          const declared = Number(typeof response.headers['content-length'] === 'string' ? response.headers['content-length'] : Number.NaN)
          if (request.limit !== undefined && Number.isFinite(declared) && declared > request.limit) {
            finish({ kind: 'failure', reason: 'network' })
            call.abort()
            return
          }
          const contentLength = Number.isFinite(declared) && declared >= 0 ? declared : undefined
          expire()
          const body = (async function *read(): AsyncGenerator<Uint8Array> {
            for await (const chunk of responseChunks(response, expire)) {
              received += chunk.byteLength
              if (request.limit !== undefined && received > request.limit) {
                call.abort()
                throw new Error('community update: response exceeded its bound')
              }
              yield chunk
            }
          })()
          finish({
            kind: 'body',
            status: response.statusCode,
            body,
            ...contentLength === undefined ? {} : { contentLength },
          })
        })
        call.end()
      })
    },
  }
}

/** Everything the product wiring needs from its owner. */
export interface DesktopCommunityUpdateOptions {
  /** Shell locale reader; every presentation is built in the language current at the time. */
  readonly locale: () => DesktopLocale
  /** The fork's version facts, or undefined on a build that read none. */
  readonly community: CommunityVersionIdentity | undefined
  /** The fork's release identity, or undefined when this build declared no release source. */
  readonly release: CommunityReleaseIdentity | undefined
  /** Platform and architecture the manifest is read for; defaults to the running process. */
  readonly platform?: { readonly os: string; readonly arch: string }
  /** Harness home to stage under; defaults to the resolved home of this process. */
  readonly home?: string
  /** Transport seam; a test supplies a literal exchange instead of the machine's network. */
  readonly transport?: CommunityUpdateTransport
  /** Store seam; a test supplies an in-memory staging directory. */
  readonly store?: CommunityUpdateStore
}

/** The wired Community Update surface, as the shell's owner uses it. */
export interface DesktopCommunityUpdate {
  /** Open the update window, or focus the one already open. */
  open(): void
  /**
   * The state the update service is in, for the diagnostics report.
   * @returns the current state.
   */
  state(): CommunityUpdateState
  /**
   * The read-only update facts the diagnostics report renders.
   *
   * It is derived here rather than in `main.ts` so the two surfaces cannot disagree about which field
   * means what, and so the report can never receive a value the update service did not produce.
   * @returns the facts, or undefined when this build has no update surface at all.
   */
  facts(): CommunityDiagnosticsUpdateFacts | undefined
  /** Release the window and its IPC handlers. */
  dispose(): void
}

/**
 * Create the Community Update surface the application menu opens.
 *
 * The service and the window are built together because each needs the other: the service pushes every
 * state change into the window, and the window asks the service for the two operations. Only one order
 * is possible — the service is constructed first, and it must already be able to reach a window that
 * does not exist yet — so the window is held in one cell that the push reads. The cell is filled
 * before anything can publish, so the service never pushes into a half-built window.
 * @param options - the wiring's injected facts and seams.
 * @returns the window to open and dispose, together with its state reader.
 */
export function createDesktopCommunityUpdate(options: DesktopCommunityUpdateOptions): DesktopCommunityUpdate {
  const home = options.home ?? resolveDshHome()
  const store = options.store ?? createCommunityUpdateStore({ home })
  const transport = options.transport ?? createCommunityUpdateTransport()
  const target: { window?: DesktopCommunityUpdateWindow } = {}
  const service = new CommunityUpdateService({
    identity: options.release,
    community: options.community,
    platform: options.platform ?? { os: process.platform, arch: process.arch },
    transport,
    store,
    onChange: (state) => { target.window?.publish(state) },
  })
  const reveal = async (): Promise<boolean> => {
    const file = service.storedFile() ?? await store.stored()
    if (file === undefined) return false
    shell.showItemInFolder(join(home, COMMUNITY_UPDATE_DIRECTORY, file.fileName))
    return true
  }
  const window = new DesktopCommunityUpdateWindow({
    // `webPreferences.preload` is an absolute path or nothing: Electron logs
    // `preload script must have absolute path` and loads no script at all for a bare file name,
    // which leaves the document without its bridge and therefore without anything to render. The
    // bundle emits this module beside the preload, so the module's own directory holds it.
    preload: join(fileURLToPath(new URL('.', import.meta.url)), COMMUNITY_UPDATE_PRELOAD),
    createWindow: (preload: string, title: string): CommunityUpdateWindowHandle => {
      const created = new BrowserWindow({
        width: COMMUNITY_UPDATE_WINDOW_SIZE.width,
        height: COMMUNITY_UPDATE_WINDOW_SIZE.height,
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
    readState: () => service.state(),
    hasStoredFile: () => service.storedFile() !== undefined,
    check: async () => await service.check(),
    download: async () => await service.download(),
    reveal,
    openNotes: async (url: string): Promise<boolean> => { await shell.openExternal(url); return true },
    copy: (): CommunityUpdateCopy => communityUpdateCopy(options.locale()),
  })
  target.window = window
  return {
    open: () => { window.open() },
    state: () => service.state(),
    facts: () => {
      const state = service.state()
      return {
        ...state.source === '' ? {} : { source: state.source },
        channel: state.channel,
        phase: state.phase,
        ...state.latestVersion === undefined ? {} : { latestVersion: state.latestVersion },
        ...state.manifestSchema === undefined ? {} : { schemaVersion: state.manifestSchema },
        stored: service.storedFile() !== undefined,
      }
    },
    dispose: () => { window.dispose(); service.dispose() },
  }
}

/**
 * The shell's copy for one update presentation.
 *
 * Every word comes from the locale the shell already owns, so the document hard-codes nothing and a
 * language change is reflected the next time a state is presented. The status map is keyed by the
 * phase token the service reports, which is what keeps the two from drifting: a phase with no wording
 * fails to compile rather than rendering as an empty line.
 * @param locale - the locale current when the presentation is built.
 * @returns the copy the window attaches to the service's state.
 */
export function communityUpdateCopy(locale: DesktopLocale): CommunityUpdateCopy {
  const { messages } = locale
  return {
    locale: locale.id,
    title: messages.communityUpdateTitle,
    status: {
      idle: messages.communityUpdateStatusIdle,
      checking: messages.communityUpdateStatusChecking,
      'up-to-date': messages.communityUpdateStatusUpToDate,
      'update-available': messages.communityUpdateStatusAvailable,
      downloading: messages.communityUpdateStatusDownloading,
      downloaded: messages.communityUpdateStatusDownloaded,
      verifying: messages.communityUpdateStatusVerifying,
      ready: messages.communityUpdateStatusReady,
      'network-error': messages.communityUpdateStatusNetworkError,
      'invalid-manifest': messages.communityUpdateStatusInvalidManifest,
      'download-error': messages.communityUpdateStatusDownloadError,
      'checksum-error': messages.communityUpdateStatusChecksumError,
      'unsupported-platform': messages.communityUpdateStatusUnsupportedPlatform,
    },
    detail: {
      idle: messages.communityUpdateDetailIdle,
      ready: messages.communityUpdateDetailReady,
      'network-error': messages.communityUpdateDetailNetworkError,
      'invalid-manifest': messages.communityUpdateDetailInvalidManifest,
      'download-error': messages.communityUpdateDetailDownloadError,
      'checksum-error': messages.communityUpdateDetailChecksumError,
      'unsupported-platform': messages.communityUpdateDetailUnsupportedPlatform,
    },
    rows: {
      currentVersion: messages.communityUpdateRowCurrentVersion,
      latestVersion: messages.communityUpdateRowLatestVersion,
      upstreamBase: messages.communityUpdateRowUpstreamBase,
      publishedAt: messages.communityUpdateRowPublishedAt,
      saveLocation: messages.communityUpdateRowSaveLocation,
    },
    actions: {
      check: messages.communityUpdateActionCheck,
      download: messages.communityUpdateActionDownload,
      openLocation: messages.communityUpdateActionOpenLocation,
      viewNotes: messages.communityUpdateActionViewNotes,
      close: messages.communityUpdateActionClose,
    },
    progressKnown: messages.communityUpdateProgressKnown,
    progressUnknown: messages.communityUpdateProgressUnknown,
  }
}
