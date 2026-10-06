/**
 * What a user reads, and what they may press, for each Community Update state.
 *
 * The presentation layer is where the surface's safety is actually visible: a phase that offers no way
 * to reach a refused file is the reason a refused download cannot be run by hand. So the cases pin the
 * *absence* of actions as carefully as their presence — a `checksum-error` offers a retry and nothing
 * else, a transfer in flight offers only Close, and an available release offers to view notes only
 * when the release published a page.
 *
 * The copy is a parameter rather than a lookup, and the last cases use two different dictionaries to
 * prove it: a module that hard-coded a status line would render the same text for both, which is the
 * one thing an English-only assertion could not catch.
 */
import { describe, expect, it } from 'vitest'
import { presentCommunityUpdate, formatCommunityUpdateAmount } from '../src/community-update-presentation.ts'
import type { CommunityUpdateCopy } from '../src/community-update-ipc.ts'
import type { CommunityUpdatePhase, CommunityUpdateState } from '../src/community-update-service.ts'

/** The phases one state can report, in the order the service reaches them. */
const PHASES: readonly CommunityUpdatePhase[] = [
  'idle', 'checking', 'up-to-date', 'update-available', 'downloading', 'downloaded', 'verifying', 'ready',
  'network-error', 'invalid-manifest', 'download-error', 'checksum-error', 'unsupported-platform',
]

/** One dictionary, every value distinct so a substituted label would be visible. */
const COPY: CommunityUpdateCopy = {
  locale: 'en',
  title: 'title',
  status: Object.fromEntries(PHASES.map(phase => [phase, `status of ${phase}`])) as CommunityUpdateCopy['status'],
  detail: { 'checksum-error': 'detail of checksum-error', ready: 'detail of ready' },
  rows: {
    currentVersion: 'row current', latestVersion: 'row latest', upstreamBase: 'row upstream',
    publishedAt: 'row published', saveLocation: 'row save',
  },
  actions: {
    check: 'action check', download: 'action download', openLocation: 'action open',
    viewNotes: 'action notes', close: 'action close',
  },
  progressKnown: '{received} of {total}',
  progressUnknown: '{received} so far',
}

/** Another dictionary, so a case can prove the copy came from the caller's. */
const OTHER: CommunityUpdateCopy = {
  ...COPY,
  locale: 'zh',
  title: '另一个标题',
  status: Object.fromEntries(PHASES.map(phase => [phase, `状态 ${phase}`])) as CommunityUpdateCopy['status'],
  actions: { ...COPY.actions, openLocation: '打开文件位置' },
}

/** One state for a phase, with the facts a real check or transfer would have supplied. */
function state(phase: CommunityUpdatePhase, overrides: Partial<CommunityUpdateState> = {}): CommunityUpdateState {
  return {
    phase,
    currentVersion: 'v0.2-dev',
    channel: 'development',
    source: 'newplayer0408-jpg/deepseek-harness',
    ...overrides,
  }
}

/** The action labels a phase permits, with the empty ones dropped. */
function offered(phase: CommunityUpdatePhase, overrides: Partial<CommunityUpdateState> = {}): string[] {
  const actions = presentCommunityUpdate(COPY, state(phase, overrides)).actions
  return Object.entries(actions).filter(([, label]) => label !== '').map(([name]) => name).sort()
}

describe('what one state offers', () => {
  it('offers a check wherever nothing is in flight and nothing is ready', () => {
    for (const phase of ['idle', 'up-to-date', 'network-error', 'invalid-manifest'] as const) {
      expect(offered(phase), phase).toEqual(['check', 'close'])
    }
  })

  it('offers the download of an available release, and nowhere to download it from in the view', () => {
    expect(offered('update-available')).toEqual(['close', 'download'])
    // The release page is offered only when the release published one, and the view carries no URL:
    // the window resolves it from the state it already holds.
    expect(offered('update-available', { releaseNotesUrl: 'https://github.com/a/b/releases/tag/community-v0.3' }))
      .toEqual(['close', 'download', 'viewNotes'])
  })

  it('offers to reveal a file only once a download is verified', () => {
    for (const phase of ['downloaded', 'ready'] as const) {
      expect(offered(phase), phase).toEqual(['check', 'close', 'openLocation'])
    }
  })

  it('offers a refused download nothing but a retry, and never a way to reach the refused file', () => {
    for (const phase of ['download-error', 'checksum-error'] as const) {
      // `checksum-error` carries a fault and a release page, and still offers no reveal and no notes:
      // the file behind a failed digest is exactly the file a user must not be able to open.
      const labels = offered(phase, {
        fault: 'checksum-mismatch',
        releaseNotesUrl: 'https://github.com/a/b/releases/tag/community-v0.3',
      })
      expect(labels, phase).toEqual(['close', 'download'])
    }
  })

  it('offers only Close while a check or a transfer is in flight, and on a platform with no installer', () => {
    for (const phase of ['checking', 'downloading', 'verifying', 'unsupported-platform'] as const) {
      // Nothing to press is the honest set of options: a second request would join the first one, and
      // a platform with no published installer has nothing to fetch.
      expect(offered(phase), phase).toEqual(['close'])
    }
  })

  it('offers every phase a way to close, and carries the phase token unchanged', () => {
    for (const phase of PHASES) {
      const view = presentCommunityUpdate(COPY, state(phase))
      expect(view.actions.close, phase).toBe('action close')
      expect(view.phase, phase).toBe(phase)
      expect(view.status, phase).toBe(`status of ${phase}`)
    }
  })
})

describe('the facts one state shows', () => {
  it('shows the running version, and adds each release fact only when the check supplied one', () => {
    expect(presentCommunityUpdate(COPY, state('idle')).rows).toEqual([{ label: 'row current', value: 'v0.2-dev' }])
    expect(presentCommunityUpdate(COPY, state('update-available', {
      latestVersion: 'v0.3', upstreamBase: 'dsh-v0.2.0-rc.2', publishedAt: '2026-10-06T00:00:00.000Z',
    })).rows).toEqual([
      { label: 'row current', value: 'v0.2-dev' },
      { label: 'row latest', value: 'v0.3' },
      { label: 'row upstream', value: 'dsh-v0.2.0-rc.2' },
      { label: 'row published', value: '2026-10-06T00:00:00.000Z' },
    ])
  })

  it('leaves the version row out of a build that declared none, rather than rendering an empty one', () => {
    expect(presentCommunityUpdate(COPY, state('idle', { currentVersion: '' })).rows).toEqual([])
  })

  it('shows where a download is going, in the symbolic form the service reported', () => {
    const view = presentCommunityUpdate(COPY, state('downloading', {
      progress: { received: 1024, total: 2048, percent: 50, fileName: 'setup.exe', directory: '~/.dsh-community/updates' },
    }))
    expect(view.rows).toEqual([
      { label: 'row current', value: 'v0.2-dev' },
      { label: 'row save', value: '~/.dsh-community/updates/setup.exe' },
    ])
    expect(view.progress).toEqual({ percent: 50, text: '1.0 KiB of 2.0 KiB' })
  })

  it('reports a transfer with no declared total without a percentage', () => {
    const view = presentCommunityUpdate(COPY, state('downloading', {
      progress: { received: 4096, fileName: 'setup.exe', directory: '~/.dsh-community/updates' },
    }))
    expect(view.progress).toEqual({ text: '4.0 KiB so far' })
    expect(view.progress).not.toHaveProperty('percent')
  })

  it('carries the fault as a code rather than as a message, and nothing when none applies', () => {
    expect(presentCommunityUpdate(COPY, state('checksum-error', { fault: 'checksum-mismatch' })).code).toBe('checksum-mismatch')
    expect(presentCommunityUpdate(COPY, state('ready')).code).toBe('')
  })

  it('carries the detail the dictionary has for a phase, and none for a phase it does not describe', () => {
    expect(presentCommunityUpdate(COPY, state('checksum-error')).detail).toBe('detail of checksum-error')
    expect(presentCommunityUpdate(COPY, state('ready')).detail).toBe('detail of ready')
    expect(presentCommunityUpdate(COPY, state('downloading')).detail).toBe('')
  })

  it('holds no URL, no absolute path, and no digest for the document to act on', () => {
    const view = presentCommunityUpdate(COPY, state('ready', {
      releaseNotesUrl: 'https://github.com/a/b/releases/tag/community-v0.3',
      verifiedSha256: 'c'.repeat(64),
      progress: { received: 1, total: 1, percent: 100, fileName: 'setup.exe', directory: '~/.dsh-community/updates' },
    }))
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain('https://')
    expect(serialized).not.toContain('c'.repeat(64))
    expect(serialized).not.toContain('C:\\')
    expect(Object.keys(view).sort()).toEqual(['actions', 'code', 'detail', 'locale', 'phase', 'progress', 'rows', 'status', 'title'])
  })
})

describe('the dictionary the surface reads', () => {
  it('takes every word from the copy it was given', () => {
    const english = presentCommunityUpdate(COPY, state('update-available', { latestVersion: 'v0.3' }))
    const chinese = presentCommunityUpdate(OTHER, state('update-available', { latestVersion: 'v0.3' }))
    expect(english.title).toBe('title')
    expect(chinese.title).toBe('另一个标题')
    expect(english.locale).toBe('en')
    expect(chinese.locale).toBe('zh')
    expect(english.status).not.toBe(chinese.status)
    // The fact rows are facts: only the labels come from the dictionary.
    expect(chinese.rows).toEqual(english.rows)
  })
})

describe('how a transfer amount is rendered', () => {
  it('reports bytes, kibibytes, and mebibytes, and never a negative or fractional count', () => {
    expect(formatCommunityUpdateAmount(0)).toBe('0 B')
    expect(formatCommunityUpdateAmount(512)).toBe('512 B')
    expect(formatCommunityUpdateAmount(1024)).toBe('1.0 KiB')
    expect(formatCommunityUpdateAmount(1024 * 1024 - 1)).toBe('1024.0 KiB')
    expect(formatCommunityUpdateAmount(1024 * 1024)).toBe('1.0 MiB')
    expect(formatCommunityUpdateAmount(287558992)).toBe('274.2 MiB')
    // A value that could not be a byte count is rendered as zero rather than as a paragraph.
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatCommunityUpdateAmount(value), String(value)).toBe('0 B')
    }
  })
})
