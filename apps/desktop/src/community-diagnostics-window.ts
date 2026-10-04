/**
 * The shell-owned Community Diagnostics window.
 *
 * The window is a presentation layer and nothing more. It asks an injected reader for the Phase 1
 * view, attaches shell copy to it, and pushes the result to its own document; it reads no
 * environment, no file, no credential, and no Host output itself, so every fact it can display
 * arrived already gated by {@link collectCommunityDiagnostics}. The report a user can copy is
 * rendered from that same view by the Phase 1 renderer, in the main process, and a clipboard that
 * refuses the write is answered as a refusal rather than as an error.
 *
 * Two consequences shape the code below.
 *
 * - The document is untrusted. Its IPC is accepted only from this window's own main frame while that
 *   frame is still on the diagnostics page, and the document may not hand the main process anything
 *   but a revision number — not text to copy, not a channel to send on.
 * - A refresh is a race between overlapping reads. The newest request wins, and a read that finishes
 *   after a later one started is discarded rather than published, so a slow collection can never
 *   overwrite a newer result. A reader that throws becomes the shell's own unavailable notice, which
 *   keeps the window usable and keeps the exception out of the document.
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  COMMUNITY_DIAGNOSTICS_IPC,
  COMMUNITY_DIAGNOSTICS_PAGE,
  type CommunityDiagnosticsCopy,
  type CommunityDiagnosticsWindowRow,
  type CommunityDiagnosticsWindowView,
} from './community-diagnostics-ipc.ts'
import {
  renderCommunityDiagnosticsReport,
  summarizeCommunityDiagnostics,
  type CommunityDiagnosticCheck,
  type CommunityDiagnosticsView,
} from './community-diagnostics.ts'

/** A presentation before the window assigns it a revision; only {@link DesktopCommunityDiagnosticsWindow} numbers one. */
type UnpublishedView = Omit<CommunityDiagnosticsWindowView, 'revision'>

/** The copy-owned fields every presentation carries, whatever the collection did. */
type CopyOwnedView = Omit<UnpublishedView, 'unavailable' | 'rows' | 'summary'>

/**
 * The part of an Electron window the diagnostics document uses, and nothing more.
 *
 * It is stated structurally rather than taken from `BrowserWindow`, because this layer reads six
 * members and no others: naming them keeps the dependency honest, and it is what lets a test drive
 * every branch — a dead renderer, a document that never loaded — without an Electron process.
 */
export interface CommunityDiagnosticsWindowHandle {
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
 * Compile-time proof that the shell's own Electron window satisfies {@link CommunityDiagnosticsWindowHandle}.
 *
 * The seam is structural so this layer stays drivable without Electron, and this is what keeps it
 * from drifting away from the object Phase 3 actually hands over: a real `BrowserWindow` satisfies
 * the interface only while the alias resolves to `true`, and
 * `apps/desktop/tests/community-diagnostics-window.spec.ts` assigns `true` to it.
 */
export type CommunityDiagnosticsWindowSeamMatchesElectron =
  BrowserWindow extends CommunityDiagnosticsWindowHandle ? true : never

/**
 * Everything the diagnostics window needs from its owner.
 *
 * Window creation and clipboard access stay outside the class because the shell owns both: Phase 3
 * supplies the real window policy (isolation, sandbox, geometry) and the real clipboard, and a test
 * supplies a fake of each without an Electron process.
 */
export interface DesktopCommunityDiagnosticsWindowOptions {
  /** Bundled isolated preload the created window loads. */
  readonly preload: string
  /**
   * Create the ordinary utility window that loads the diagnostics document.
   * @param preload - bundled isolated preload file name.
   * @param title - window title, taken from the copy current at creation.
   * @returns The created window; the owner supplies its web preferences and geometry.
   */
  readonly createWindow: (preload: string, title: string) => CommunityDiagnosticsWindowHandle
  /**
   * Read the current safe Phase 1 view.
   *
   * It must be the collector's own output: the window trusts the view's types and re-derives
   * nothing, so a reader that assembles a view by hand sits outside this contract.
   * @returns the collected view, or a rejection the window turns into its unavailable notice.
   */
  readonly readDiagnostics: () => Promise<CommunityDiagnosticsView>
  /** Shell copy, or a reader of the copy for the current UI language. */
  readonly copy: CommunityDiagnosticsCopy | (() => CommunityDiagnosticsCopy)
  /**
   * Write one report to the system clipboard.
   *
   * The window calls this with the report it rendered from the current view and with nothing else,
   * which is what keeps the document from reaching the clipboard directly. A throw or a rejection is
   * answered to the document as a refusal rather than as an error, so a failure message — which can
   * quote the report or name a system path — never reaches the diagnostics page.
   * @param report - the report rendered from the current safe view.
   */
  readonly writeReport: (report: string) => Promise<void> | void
}

/**
 * One diagnostics document at a time, with presentation and IPC owned by the main process.
 */
export class DesktopCommunityDiagnosticsWindow {
  private disposed = false
  private revision = 0
  private request = 0
  private window: CommunityDiagnosticsWindowHandle | undefined
  private diagnostics: CommunityDiagnosticsView | undefined
  private view: CommunityDiagnosticsWindowView | undefined

  /**
   * @param options - the injected window factory, diagnostics reader, copy, and clipboard writer.
   */
  constructor(private readonly options: DesktopCommunityDiagnosticsWindowOptions) {
    ipcMain.handle(COMMUNITY_DIAGNOSTICS_IPC.status, (event) => { this.owned(event); return this.view ?? null })
    ipcMain.handle(COMMUNITY_DIAGNOSTICS_IPC.refresh, async (event) => {
      this.owned(event)
      return await this.refresh()
    })
    ipcMain.handle(COMMUNITY_DIAGNOSTICS_IPC.copyReport, async (event, revision: unknown) => {
      this.owned(event)
      return await this.copyReport(revision)
    })
  }

  /** Whether a diagnostics document is open. */
  get isOpen(): boolean { return this.window !== undefined }

  /**
   * Open the diagnostics window, or focus the one already open.
   *
   * A closed window is released rather than hidden, so reopening builds a fresh document. The first
   * presentation is collected immediately, which means the document is never empty for longer than
   * one collection takes.
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
    window.webContents.on('will-navigate', (event, url) => { if (url !== COMMUNITY_DIAGNOSTICS_PAGE) event.preventDefault() })
    window.once('closed', () => { this.forget(window) })
    // A dead renderer and a document that never loaded are both windows that cannot show anything,
    // so each is closed instead of left behind as an unowned shell whose IPC would still be refused.
    window.webContents.once('render-process-gone', () => { this.discard(window) })
    void window.loadURL(COMMUNITY_DIAGNOSTICS_PAGE).catch(() => { this.discard(window) })
    void this.refresh()
  }

  /** Close the diagnostics window; reopening builds a fresh document. */
  close(): void {
    const window = this.window
    if (window === undefined) return
    this.forget(window)
    if (!window.isDestroyed()) window.destroy()
  }

  /**
   * Collect a new presentation and publish it to the owned document.
   *
   * @returns the presentation now displayed, or null when no window is open. A request superseded by
   * a newer one answers with the presentation that newer request published, never with its own.
   */
  async refresh(): Promise<CommunityDiagnosticsWindowView | null> {
    if (this.disposed || this.window === undefined) return null
    const request = ++this.request
    let diagnostics: CommunityDiagnosticsView
    try {
      diagnostics = await this.options.readDiagnostics()
    } catch {
      // The rejection is deliberately not inspected: a message from a probe can carry a path, a
      // command line, or a credential, and the document must not be able to reach any of them.
      if (request !== this.request) return this.view ?? null
      this.diagnostics = undefined
      this.publish(this.presentUnavailable(this.copy()))
      return this.view ?? null
    }
    if (request !== this.request) return this.view ?? null
    this.diagnostics = diagnostics
    this.publish(this.present(this.copy(), diagnostics))
    return this.view ?? null
  }

  /** Close the document and detach its private IPC handlers. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.close()
    ipcMain.removeHandler(COMMUNITY_DIAGNOSTICS_IPC.status)
    ipcMain.removeHandler(COMMUNITY_DIAGNOSTICS_IPC.refresh)
    ipcMain.removeHandler(COMMUNITY_DIAGNOSTICS_IPC.copyReport)
  }

  /**
   * Copy the report behind the presentation the document is displaying.
   * @param revision - the presentation the document reports it is showing.
   * @returns whether a report was written; a stale or unknown revision writes nothing, a failed
   * collection has no report to write, and a clipboard write that threw or rejected answers `false`
   * without exposing why — the document learns only that nothing was copied.
   */
  private async copyReport(revision: unknown): Promise<boolean> {
    const current = this.view
    const diagnostics = this.diagnostics
    if (current === undefined || diagnostics === undefined || revision !== current.revision) return false
    const report = renderCommunityDiagnosticsReport(diagnostics)
    try {
      await Promise.resolve(this.options.writeReport(report))
    } catch {
      // The rejection is deliberately not inspected. A clipboard write can fail with a message that
      // echoes the text it was handed or names a system path, and the document must reach neither;
      // a refusal also leaves the window usable, so the next request is collected and copied anew.
      return false
    }
    return true
  }

  /** Resolve the shell copy for this presentation. */
  private copy(): CommunityDiagnosticsCopy {
    const source = this.options.copy
    return typeof source === 'function' ? source() : source
  }

  /** Attach copy to the collected checks and publish the result as the next revision. */
  private present(copy: CommunityDiagnosticsCopy, diagnostics: CommunityDiagnosticsView): UnpublishedView {
    return {
      ...this.base(copy),
      unavailable: '',
      rows: diagnostics.checks.map(check => this.row(copy, check)),
      summary: summarizeCommunityDiagnostics(diagnostics.checks),
    }
  }

  /**
   * Present a failed collection honestly: the shell's own notice, no invented checks, and no counts.
   * @param copy - the shell copy for this presentation.
   * @returns the presentation to display, with no rows and no summary.
   */
  private presentUnavailable(copy: CommunityDiagnosticsCopy): UnpublishedView {
    return {
      ...this.base(copy),
      unavailable: copy.unavailable,
      rows: [],
      summary: { pass: 0, warn: 0, fail: 0, info: 0 },
    }
  }

  /** The copy-owned part of a presentation, shared by a collected and an unavailable one. */
  private base(copy: CommunityDiagnosticsCopy): CopyOwnedView {
    return {
      locale: copy.locale,
      title: copy.title,
      refreshLabel: copy.refresh,
      copyReportLabel: copy.copyReport,
      copiedLabel: copy.copied,
      summaryLabels: copy.summary,
    }
  }

  /** One row: the shell's label for a check id beside what the collector reported. */
  private row(copy: CommunityDiagnosticsCopy, check: CommunityDiagnosticCheck): CommunityDiagnosticsWindowRow {
    return {
      id: check.id,
      label: copy.rows[check.id],
      state: check.state,
      value: check.value,
      code: check.code ?? '',
    }
  }

  /** Assign the next revision and push it to the owned document. */
  private publish(view: UnpublishedView): void {
    const window = this.window
    if (window === undefined) return
    const published: CommunityDiagnosticsWindowView = { ...view, revision: ++this.revision }
    this.view = published
    if (!window.isDestroyed()) window.webContents.send(COMMUNITY_DIAGNOSTICS_IPC.changed, published)
  }

  /** Release one document without destroying it, invalidating any read still in flight for it. */
  private forget(window: CommunityDiagnosticsWindowHandle): void {
    if (this.window !== window) return
    this.window = undefined
    this.diagnostics = undefined
    this.view = undefined
    this.request += 1
  }

  /** Close a document that can no longer present anything. */
  private discard(window: CommunityDiagnosticsWindowHandle): void {
    if (this.window !== window) return
    this.close()
  }

  /** Reject any sender that is not this window's own main frame on the diagnostics document. */
  private owned(event: IpcMainInvokeEvent): void {
    const window = this.window
    if (window === undefined || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== COMMUNITY_DIAGNOSTICS_PAGE) {
      throw new Error('desktop community diagnostics: rejected unowned diagnostics renderer')
    }
  }
}
