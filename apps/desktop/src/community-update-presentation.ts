/**
 * Presentation for one Community Update state: the copy a user reads, chosen from the phase the
 * service reached.
 *
 * The split from the service is what keeps "what is true" and "what to say about it" separately
 * testable. The service reports a phase and a set of facts; this module decides which facts are worth
 * showing, which actions the phase permits, and which sentence describes it — all of them from the
 * shell's own dictionary, so the document that renders the result holds no user-visible string.
 *
 * Two rules are stated here because both are security-relevant rather than cosmetic.
 *
 * - **An action appears only when the phase permits it.** A verified download is the only state that
 *   offers to reveal a file, and a failed checksum offers no way to reach the file it refused, so no
 *   phase can hand a user an installer the client just rejected.
 * - **Nothing the release supplied is rendered as a message.** The version, the upstream tag, and the
 *   publication time are facts from a validated manifest and are shown as values; the sentence
 *   describing a failure comes from the shell, and the manifest's own text never reaches the user.
 */

import { formatDesktopMessage } from './locale.ts'
import type { CommunityUpdateState } from './community-update-service.ts'
import type { CommunityUpdateCopy, CommunityUpdateWindowActions, CommunityUpdateWindowRow, CommunityUpdateWindowView } from './community-update-ipc.ts'

/** A presentation before the window assigns it a revision; only the window numbers one. */
export type UnpublishedCommunityUpdateView = Omit<CommunityUpdateWindowView, 'revision'>

/** One kibibyte, the unit a transfer amount is reported in. */
const KIB = 1024

/**
 * Format one byte count for a person.
 *
 * The value is a transfer amount the shell measured, never text from a response, and it is bounded so
 * a hostile `content-length` cannot produce a paragraph.
 * @param bytes - the byte count.
 * @returns a short amount such as `287.4 MB` or `512 B`.
 */
export function formatCommunityUpdateAmount(bytes: number): string {
  const value = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0
  if (value < KIB) return `${String(value)} B`
  const kib = value / KIB
  if (kib < KIB) return `${kib.toFixed(1)} KiB`
  return `${(kib / KIB).toFixed(1)} MiB`
}

/** The actions one phase permits, with every inapplicable label left empty. */
function phaseActions(copy: CommunityUpdateCopy, state: CommunityUpdateState): CommunityUpdateWindowActions {
  const none: CommunityUpdateWindowActions = { check: '', download: '', openLocation: '', viewNotes: '', close: copy.actions.close }
  switch (state.phase) {
    case 'idle':
    case 'up-to-date':
    case 'network-error':
    case 'invalid-manifest':
      return { ...none, check: copy.actions.check }
    case 'update-available':
      return {
        ...none,
        download: copy.actions.download,
        ...state.releaseNotesUrl === undefined ? {} : { viewNotes: copy.actions.viewNotes },
      }
    case 'ready':
    case 'downloaded':
      return { ...none, openLocation: copy.actions.openLocation, check: copy.actions.check }
    case 'download-error':
    case 'checksum-error':
      return { ...none, download: copy.actions.download }
    default:
      // A check in flight, a transfer in flight, and a platform with no published installer all leave
      // the user nothing to press but Close, which is the honest set of options in each of them.
      return none
  }
}

/** The labelled facts worth showing in one state. */
function phaseRows(copy: CommunityUpdateCopy, state: CommunityUpdateState): CommunityUpdateWindowRow[] {
  const rows: CommunityUpdateWindowRow[] = []
  if (state.currentVersion !== '') rows.push({ label: copy.rows.currentVersion, value: state.currentVersion })
  if (state.latestVersion !== undefined) rows.push({ label: copy.rows.latestVersion, value: state.latestVersion })
  if (state.upstreamBase !== undefined) rows.push({ label: copy.rows.upstreamBase, value: state.upstreamBase })
  if (state.publishedAt !== undefined) rows.push({ label: copy.rows.publishedAt, value: state.publishedAt })
  const progress = state.progress
  if (progress !== undefined) {
    rows.push({ label: copy.rows.saveLocation, value: `${progress.directory}/${progress.fileName}` })
  }
  return rows
}

/**
 * Build the presentation for one state.
 *
 * @param copy - the shell copy for the language current at presentation time.
 * @param state - the state the service reported.
 * @returns the presentation the window publishes.
 */
export function presentCommunityUpdate(copy: CommunityUpdateCopy, state: CommunityUpdateState): UnpublishedCommunityUpdateView {
  const progress = state.progress
  return {
    locale: copy.locale,
    title: copy.title,
    phase: state.phase,
    status: copy.status[state.phase],
    detail: copy.detail[state.phase] ?? '',
    rows: phaseRows(copy, state),
    actions: phaseActions(copy, state),
    code: state.fault ?? '',
    ...progress === undefined ? {} : {
      progress: {
        ...progress.percent === undefined ? {} : { percent: progress.percent },
        text: formatDesktopMessage(
          progress.total === undefined ? copy.progressUnknown : copy.progressKnown,
          { received: formatCommunityUpdateAmount(progress.received), total: formatCommunityUpdateAmount(progress.total ?? 0) },
        ),
      },
    },
  }
}
