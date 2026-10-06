/**
 * The shell-owned Community Update window.
 *
 * The window is a presentation layer and nothing more. It asks the injected readers for the current
 * phase and facts, attaches shell copy to them through {@link presentCommunityUpdate}, and pushes the
 * result to its own document. It performs no network read, touches no file, and never learns a URL:
 * every fact it can display went through the update service first, and the only two operations it can
 * start are the service's own check and download.
 *
 * Three consequences shape the code below.
 *
 * - The document is untrusted. Its IPC is accepted only from this window's own main frame while that
 *   frame is still on the update page, and the document may not hand the main process anything but a
 *   revision number — not a URL to fetch, not a path to open.
 * - Revealing a file is a phase, not a capability. The reveal request is refused unless the
 *   presentation the document is showing is the one that has a verified download behind it, so a
 *   document cannot ask the shell to reveal a file no check produced.
 * - A superseded answer is dropped. A check that finishes after a newer request started never
 *   overwrites the newer result, so a slow response cannot undo what a user just asked for.
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  COMMUNITY_UPDATE_IPC,
  COMMUNITY_UPDATE_PAGE,
  type CommunityUpdateCopy,
  type CommunityUpdateWindowView,
} from './community-update-ipc.ts'
import { presentCommunityUpdate, type UnpublishedCommunityUpdateView } from './community-update-presentation.ts'
import type { CommunityUpdateState } from './community-update-service.ts'

/**
 * The part of an Electron window the update document uses, and nothing more.
 *
 * It is stated structurally rather than taken from `BrowserWindow`, because this layer reads five
 * members and no others: naming them keeps the dependency honest, and it is what lets a test drive
 * every branch — a dead renderer, a document that never loaded — without an Electron process.
 */
export interface CommunityUpdateWindowHandle {
  /** The owned document's contents. */
  readonly webContents: {
    /** The document's own frame; its URL is what the IPC guard compares. */
    readonly mainFrame: { readonly url: string }
    send(channel: string, ...args: unknown[]): void
    on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown
    once(event: 'render-process-gone', listener: () => void): unknown
  }
  loadURL(url: string): Promise<void>
  focus(): void
  isDestroyed(): boolean
  destroy(): void
  once(event: 'closed', listener: () => void): unknown
}

/**
 * Compile-time check that the shell's own Electron window satisfies {@link CommunityUpdateWindowHandle}.
 *
 * The seam is structural so this layer stays drivable without Electron, and this is what keeps it from
 * drifting away from the object the shell actually hands over: a real `BrowserWindow` satisfies the
 * interface only while the alias resolves to `true`, and
 * `apps/desktop/tests/community-update-window.spec.ts` assigns `true` to it.
 */
export type CommunityUpdateWindowSeamMatchesElectron =
  BrowserWindow extends CommunityUpdateWindowHandle ? true : never

/**
 * Everything the update window needs from its owner.
 *
 * Window creation, the file reveal, and the two operations stay outside the class because the shell
 * owns all three: the shell supplies the real window policy, the real platform reveal, and the service
 * that performs the work, and a test supplies a fake of each without an Electron process.
 */
export interface DesktopCommunityUpdateWindowOptions {
  /** Bundled isolated preload the created window loads. */
  readonly preload: string
  /**
   * Create the ordinary utility window that loads the update document.
   * @param preload - bundled isolated preload file name.
   * @param title - window title, taken from the copy current at creation.
   * @returns The created window; the owner supplies its web preferences and geometry.
   */
  readonly createWindow: (preload: string, title: string) => CommunityUpdateWindowHandle
  /** The state the service is in. */
  readonly readState: () => CommunityUpdateState
  /** Whether a verified installer is currently on disk. */
  readonly hasStoredFile: () => boolean
  /**
   * Run one check and report the state it produced.
   * @returns the state after the check.
   */
  readonly check: () => Promise<CommunityUpdateState>
  /**
   * Download and verify the offered installer, reporting the state it produced.
   * @returns the state after the download.
   */
  readonly download: () => Promise<CommunityUpdateState>
  /**
   * Reveal the verified installer in the platform's file manager.
   *
   * It is called only for a presentation that has a verified download behind it. A throw or a
   * rejection is answered to the document as a refusal rather than as an error, so a failure message
   * — which can name a system path — never reaches the update page.
   * @returns whether a file was revealed.
   */
  readonly reveal: () => Promise<boolean> | boolean
  /**
   * Open one release page in the user's browser.
   *
   * The URL is the one the validated manifest carried for the release the shell is displaying; the
   * document never supplies it. A throw or a rejection is answered as a refusal, for the same reason
   * {@link DesktopCommunityUpdateWindowOptions.reveal} is.
   * @param url - the release page the shell resolved.
   * @returns whether a page was opened.
   */
  readonly openNotes: (url: string) => Promise<boolean> | boolean
  /** Shell copy, or a reader of the copy for the current UI language. */
  readonly copy: CommunityUpdateCopy | (() => CommunityUpdateCopy)
}

/** One update document at a time, with presentation and IPC owned by the main process. */
export class DesktopCommunityUpdateWindow {
  private disposed = false
  private revision = 0
  private request = 0
  private window: CommunityUpdateWindowHandle | undefined
  private view: CommunityUpdateWindowView | undefined
  /** The state the current presentation was built from, which is what a reveal or a notes request is checked against. */
  private state: CommunityUpdateState | undefined
  /** The state observed while no document was open, published when one opens next. */
  private pending: CommunityUpdateState | undefined

  /**
   * @param options - the injected window factory, readers, operations, reveal, and copy.
   */
  constructor(private readonly options: DesktopCommunityUpdateWindowOptions) {
    ipcMain.handle(COMMUNITY_UPDATE_IPC.status, (event) => { this.owned(event); return this.view ?? null })
    ipcMain.handle(COMMUNITY_UPDATE_IPC.check, async (event) => {
      this.owned(event)
      return await this.operate(async () => await this.options.check())
    })
    ipcMain.handle(COMMUNITY_UPDATE_IPC.download, async (event) => {
      this.owned(event)
      return await this.operate(async () => await this.options.download())
    })
    ipcMain.handle(COMMUNITY_UPDATE_IPC.openLocation, async (event, revision: unknown) => {
      this.owned(event)
      return await this.reveal(revision)
    })
    ipcMain.handle(COMMUNITY_UPDATE_IPC.openNotes, async (event, revision: unknown) => {
      this.owned(event)
      return await this.notes(revision)
    })
  }

  /** Whether an update document is open. */
  get isOpen(): boolean { return this.window !== undefined }

  /**
   * Open the update window, or focus the one already open.
   *
   * A closed window is released rather than hidden, so reopening builds a fresh document, and the
   * current state is published immediately so the document is never empty for longer than one paint.
   */
  open(): void {
    if (this.disposed) return
    const open = this.window
    if (open !== undefined) {
      if (!open.isDestroyed()) { open.focus(); return }
      this.forget(open)
    }
    const window = this.options.createWindow(this.options.preload, this.copy().title)
    this.window = window
    // The document has no route of its own: any attempt to leave it is refused rather than followed.
    window.webContents.on('will-navigate', (event, url) => { if (url !== COMMUNITY_UPDATE_PAGE) event.preventDefault() })
    window.once('closed', () => { this.forget(window) })
    // A dead renderer and a document that never loaded are both windows that cannot show anything,
    // so each is closed instead of left behind as an unowned shell whose IPC would still be refused.
    window.webContents.once('render-process-gone', () => { this.discard(window) })
    void window.loadURL(COMMUNITY_UPDATE_PAGE).catch(() => { this.discard(window) })
    const state = this.pending ?? this.options.readState()
    this.pending = undefined
    this.publish(state)
  }

  /** Close the update window; reopening builds a fresh document. */
  close(): void {
    const window = this.window
    if (window === undefined) return
    this.forget(window)
    if (!window.isDestroyed()) window.destroy()
  }

  /**
   * Publish one state to the owned document.
   *
   * The owner calls this for every state the service reports, which is how a transfer's progress
   * reaches the document without the document polling for it.
   * @param state - the state now in effect.
   */
  publish(state: CommunityUpdateState): void {
    if (this.disposed) return
    if (this.window === undefined) {
      // A state observed while no document is open is still remembered, so reopening shows what
      // happened rather than resetting to the service's own starting state.
      this.pending = state
      return
    }
    this.state = state
    const presented: UnpublishedCommunityUpdateView = presentCommunityUpdate(this.copy(), state)
    this.view = { ...presented, revision: ++this.revision }
    this.publishCurrent()
  }

  /** Close the document and detach its private IPC handlers. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.close()
    ipcMain.removeHandler(COMMUNITY_UPDATE_IPC.status)
    ipcMain.removeHandler(COMMUNITY_UPDATE_IPC.check)
    ipcMain.removeHandler(COMMUNITY_UPDATE_IPC.download)
    ipcMain.removeHandler(COMMUNITY_UPDATE_IPC.openLocation)
    ipcMain.removeHandler(COMMUNITY_UPDATE_IPC.openNotes)
  }

  /**
   * Run one of the two operations and publish whatever state it produced.
   * @param operation - the operation to run.
   * @returns the presentation now displayed, or null when no window is open.
   */
  private async operate(operation: () => Promise<CommunityUpdateState>): Promise<CommunityUpdateWindowView | null> {
    const request = ++this.request
    try {
      const state = await operation()
      if (request !== this.request) return this.view ?? null
      this.publish(state)
    } catch {
      // The rejection is deliberately not inspected: a transport failure can quote a URL or a path,
      // and the document must reach neither. The last published state stays on screen, so the user
      // keeps the result of the step that did succeed.
    }
    return this.view ?? null
  }

  /**
   * Reveal the verified installer behind the presentation the document reports it is showing.
   * @param revision - the presentation the document reports.
   * @returns whether a file was revealed; a stale or unknown revision, no verified download, and a
   * reveal that threw all answer `false` without exposing why.
   */
  private async reveal(revision: unknown): Promise<boolean> {
    const current = this.view
    if (current === undefined || revision !== current.revision || !this.options.hasStoredFile()) return false
    try {
      return await this.options.reveal()
    } catch {
      return false
    }
  }

  /**
   * Open the release page of the release the document is showing.
   * @param revision - the presentation the document reports.
   * @returns whether a page was opened; a stale or unknown revision, a release that published no
   * page, and a page that threw all answer `false` without exposing why.
   */
  private async notes(revision: unknown): Promise<boolean> {
    const current = this.view
    const url = this.state?.releaseNotesUrl
    if (current === undefined || revision !== current.revision || url === undefined) return false
    try {
      return await this.options.openNotes(url)
    } catch {
      return false
    }
  }

  /** Resolve the shell copy for this presentation. */
  private copy(): CommunityUpdateCopy {
    const source = this.options.copy
    return typeof source === 'function' ? source() : source
  }

  /** Push the current presentation to the owned document. */
  private publishCurrent(): void {
    const window = this.window
    const view = this.view
    if (window === undefined || view === undefined) return
    if (!window.isDestroyed()) window.webContents.send(COMMUNITY_UPDATE_IPC.changed, view)
  }

  /** Release one document without destroying it, invalidating any operation still in flight for it. */
  private forget(window: CommunityUpdateWindowHandle): void {
    if (this.window !== window) return
    this.window = undefined
    this.view = undefined
    this.state = undefined
    this.request += 1
  }

  /** Close a document that can no longer present anything. */
  private discard(window: CommunityUpdateWindowHandle): void {
    if (this.window !== window) return
    this.close()
  }

  /** Reject any sender that is not this window's own main frame on the update document. */
  private owned(event: IpcMainInvokeEvent): void {
    const window = this.window
    if (window === undefined || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== COMMUNITY_UPDATE_PAGE) {
      throw new Error('desktop community update: rejected unowned update renderer')
    }
  }
}
