/**
 * Community Diagnostics window contract: the private channels, the shell document, and the shapes
 * exchanged across the isolated boundary.
 *
 * This module exists to be dependency-free, and that is a build constraint rather than a style
 * preference. The isolated preload imports it, and a sandboxed preload's `require` polyfill resolves
 * only `electron`, `events`, `timers`, and `url` — so a value import added here would not merely
 * bloat the preload, it would fail the bundle: `apps/desktop/scripts/desktop-bundle-imports.mjs`
 * walks every parsed module before tree-shaking, and the probe engine reaches `node:fs/promises`,
 * `node:os`, and `node:path` through `@deepseek-ai/dsh-home-paths`. A type-only import is erased
 * before the bundle sees it, which is why the engine may be named below and still never load here.
 */

import type {
  CommunityDiagnosticId,
  CommunityDiagnosticsState,
  CommunityDiagnosticsSummary,
} from './community-diagnostics.ts'

/**
 * Channels available only to the isolated Community Diagnostics document.
 *
 * They live beside the window that owns them rather than in `src/ipc.ts`, which every shell window
 * shares; nothing outside this feature may reach them.
 */
export const COMMUNITY_DIAGNOSTICS_IPC = {
  status: 'dsh-community-diagnostics:status',
  refresh: 'dsh-community-diagnostics:refresh',
  copyReport: 'dsh-community-diagnostics:copy-report',
  changed: 'dsh-community-diagnostics:changed',
} as const

/** The shell document the diagnostics window owns, and the only URL its IPC accepts. */
export const COMMUNITY_DIAGNOSTICS_PAGE = 'dsh-app://shell/community-diagnostics.html'

/** Bundled isolated preload the diagnostics window loads. */
export const COMMUNITY_DIAGNOSTICS_PRELOAD = 'preload-community-diagnostics.cjs'

/**
 * Recommended content size for the diagnostics window.
 *
 * A utility window rather than a dialog: it blocks nothing, tracks no parent geometry, and holds a
 * fixed list, so one size covers eleven check rows, a summary, and two buttons.
 */
export const COMMUNITY_DIAGNOSTICS_WINDOW_SIZE = { width: 640, height: 620 } as const

/** Noun the document prints beside each state's count, in the shell's own language. */
export interface CommunityDiagnosticsSummaryLabels {
  readonly pass: string
  readonly warn: string
  readonly fail: string
  readonly info: string
}

/** One presented check: a shell-owned label plus what the collector reported. */
export interface CommunityDiagnosticsWindowRow {
  readonly id: CommunityDiagnosticId
  readonly label: string
  readonly state: CommunityDiagnosticsState
  readonly value: string
  /** Stable code for a non-pass condition, or empty when the check passed. */
  readonly code: string
}

/**
 * Everything the diagnostics document may display.
 *
 * Each field is either a fact the collector already reduced or copy the shell owns, so the document
 * formats a presentation it cannot widen: it holds no path, no probe target, no credential, and no
 * exception text, and it exposes nothing the main process did not choose to put here.
 */
export interface CommunityDiagnosticsWindowView {
  /** Identifies this presentation, so a copy request from an older one is recognizably stale. */
  readonly revision: number
  readonly locale: string
  readonly title: string
  readonly refreshLabel: string
  readonly copyReportLabel: string
  readonly copiedLabel: string
  readonly summaryLabels: CommunityDiagnosticsSummaryLabels
  /** Shell copy shown in place of the checks when collection failed; empty on success. */
  readonly unavailable: string
  readonly rows: readonly CommunityDiagnosticsWindowRow[]
  readonly summary: CommunityDiagnosticsSummary
}

/**
 * Shell-owned presentation copy.
 *
 * The document hard-codes no user-visible string, so every label it shows arrives through here; the
 * diagnostics window reads it (or a reader of it) and Phase 3 connects the shell locale dictionary.
 */
export interface CommunityDiagnosticsCopy {
  readonly locale: string
  readonly title: string
  readonly refresh: string
  readonly copyReport: string
  /** Acknowledges one copied report. */
  readonly copied: string
  /** Shown instead of the checks when collection threw; never carries the exception. */
  readonly unavailable: string
  readonly summary: CommunityDiagnosticsSummaryLabels
  /** One label per check id, in the shell's own language. */
  readonly rows: Readonly<Record<CommunityDiagnosticId, string>>
}

/**
 * The document may read the current presentation, ask for a fresh one, and copy the report behind
 * it — nothing else, and no channel of its own choosing.
 */
export interface CommunityDiagnosticsWindowApi {
  status(): Promise<CommunityDiagnosticsWindowView | null>
  refresh(): Promise<CommunityDiagnosticsWindowView | null>
  /**
   * Copy the report behind one presentation.
   * @param revision - the presentation the document is showing, and the only thing it may supply.
   * @returns whether a report was written; `false` also answers a stale revision and a clipboard
   * write that failed, and never carries a reason.
   */
  copyReport(revision: number): Promise<boolean>
  subscribe(listener: (view: CommunityDiagnosticsWindowView) => void): () => void
}
