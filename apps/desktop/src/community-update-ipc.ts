/**
 * Community Update window contract: the private channels, the shell document, and the shapes
 * exchanged across the isolated boundary.
 *
 * This module exists to be dependency-free, and that is a build constraint rather than a style
 * preference. The isolated preload imports it, and a sandboxed preload's `require` polyfill resolves
 * only `electron`, `events`, `timers`, and `url` — so a value import added here would fail the
 * bundle, not merely bloat the preload. A type-only import is erased before the bundle sees it, which
 * is why the service and download modules may be named below and still never load here.
 */

import type { CommunityUpdateState } from './community-update-service.ts'

/**
 * Channels available only to the isolated Community Update document.
 *
 * They live beside the window that owns them rather than in `src/ipc.ts`, which every shell window
 * shares; nothing outside this feature may reach them. Each channel is one thing the document may
 * ask for and nothing more — in particular there is no channel that takes a URL, so a document can
 * never direct the main process to fetch somewhere of its own choosing.
 */
export const COMMUNITY_UPDATE_IPC = {
  status: 'dsh-community-update:status',
  check: 'dsh-community-update:check',
  download: 'dsh-community-update:download',
  openLocation: 'dsh-community-update:open-location',
  openNotes: 'dsh-community-update:open-notes',
  changed: 'dsh-community-update:changed',
} as const

/** The shell document the update window owns, and the only URL its IPC accepts. */
export const COMMUNITY_UPDATE_PAGE = 'dsh-app://shell/community-update.html'

/** Bundled isolated preload the update window loads. */
export const COMMUNITY_UPDATE_PRELOAD = 'preload-community-update.cjs'

/**
 * Recommended content size for the update window.
 *
 * A utility window rather than a dialog: it blocks nothing and holds a status line, up to a handful
 * of labelled facts, and at most three actions, so one size covers every phase.
 */
export const COMMUNITY_UPDATE_WINDOW_SIZE = { width: 620, height: 560 } as const

/** One labelled fact the document shows: a shell-owned label beside a value the shell formatted. */
export interface CommunityUpdateWindowRow {
  readonly label: string
  readonly value: string
}

/**
 * The action labels for one presentation.
 *
 * Each label is either the shell's own word for that action or an empty string, and an empty string
 * is how the shell says the action does not apply to the phase being shown. The document therefore
 * decides nothing about what is possible; it only renders what it was given.
 */
export interface CommunityUpdateWindowActions {
  readonly check: string
  readonly download: string
  readonly openLocation: string
  readonly viewNotes: string
  readonly close: string
}

/** Transfer progress, already reduced to a display value and an optional percentage. */
export interface CommunityUpdateWindowProgress {
  /** Percentage 0–100, present only when the release declared a size. */
  readonly percent?: number
  /** Human-readable transfer amount, formatted by the shell. */
  readonly text: string
}

/**
 * Everything the update document may display.
 *
 * Each field is either a fact the service read from a validated manifest — already reduced to a
 * short display form — or copy the shell owns. The document holds no URL, no path, no digest, and no
 * exception text, and it exposes nothing the main process did not choose to put here.
 */
export interface CommunityUpdateWindowView {
  /** Identifies this presentation, so a request from an older one is recognizably stale. */
  readonly revision: number
  readonly locale: string
  readonly title: string
  /** Phase the shell is in, as a stable token the document never translates. */
  readonly phase: CommunityUpdateState['phase']
  /** One-line status for that phase. */
  readonly status: string
  /** Extra guidance for the phase, when the shell has any; empty otherwise. */
  readonly detail: string
  readonly rows: readonly CommunityUpdateWindowRow[]
  readonly actions: CommunityUpdateWindowActions
  /** Transfer progress, present only while a download is in flight. */
  readonly progress?: CommunityUpdateWindowProgress
  /** Stable code for the condition being reported, or empty when none applies. */
  readonly code: string
}

/**
 * Shell-owned presentation copy, read for the language current when a state is presented.
 *
 * The document hard-codes no user-visible string, so every label it shows arrives through the view
 * the shell built from this copy.
 */
export interface CommunityUpdateCopy {
  readonly locale: string
  readonly title: string
  /** One status line per phase, keyed by the phase token the presentation carries. */
  readonly status: Readonly<Record<CommunityUpdateState['phase'], string>>
  /** Extra guidance per phase; a phase absent from this record shows no detail. */
  readonly detail: Readonly<Record<string, string>>
  /** One label per fact the document may show. */
  readonly rows: {
    readonly currentVersion: string
    readonly latestVersion: string
    readonly upstreamBase: string
    readonly publishedAt: string
    readonly saveLocation: string
  }
  readonly actions: CommunityUpdateWindowActions
  /** Transfer amount once the total is known, and before it is. */
  readonly progressKnown: string
  readonly progressUnknown: string
}

/**
 * The document may read the current presentation, ask for a check, ask for the validated download,
 * reveal the verified file, and open the release page the shell already holds — nothing else, and no
 * destination of its own choosing. No channel below accepts a URL or a path from the document.
 */
export interface CommunityUpdateWindowApi {
  status(): Promise<CommunityUpdateWindowView | null>
  check(): Promise<CommunityUpdateWindowView | null>
  download(): Promise<CommunityUpdateWindowView | null>
  /**
   * Reveal the verified installer in the platform's file manager.
   * @param revision - the presentation the document is showing, and the only thing it may supply.
   * @returns whether a file was revealed; `false` also answers a stale revision and a reveal that
   * failed, and never carries a reason.
   */
  openLocation(revision: number): Promise<boolean>
  /**
   * Open the release page of the offered release in the user's browser.
   * @param revision - the presentation the document is showing, and the only thing it may supply.
   * @returns whether a page was opened; `false` also answers a stale revision, a release that
   * published no page, and a page that could not be opened.
   */
  openNotes(revision: number): Promise<boolean>
  subscribe(listener: (view: CommunityUpdateWindowView) => void): () => void
}
