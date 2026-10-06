/**
 * About is where a user reads what they are running, and it is the one surface where the two version
 * series meet: the line a release has always shown survives unchanged, and a community build shows its
 * own version beside the upstream base it was synced to.
 *
 * These cases pin all three directions. A release build must not acquire community wording, a
 * community build must name the fork's version without losing the build it packages, and the wording
 * must come from the locale dictionary rather than from this module — a hardcoded line would pass an
 * English-only assertion and ship a Chinese user an English dialog.
 *
 * The commit line has a fourth direction of its own: the base tag is what the fork commits, and the
 * commit is derived from it when a build runs, so a build that resolved none renders one line fewer
 * rather than a line naming nothing.
 *
 * The last two lines are the update story, and they are pinned as hard as the version facts: the
 * channel is read from the version line above it so the two cannot disagree, and the status line says
 * only that Community updates are checked on request — never that the build is up to date, which would
 * claim a comparison nobody made.
 */
import { describe, expect, it } from 'vitest'
import type { CommunityVersionIdentity } from '../src/community-version.ts'
import { desktopAboutDetail, type DesktopAboutVersions } from '../src/community-version-presentation.ts'
import { en, zh } from '../src/locale.ts'

/** A commit a packaging run recorded: shaped like one, and belonging to no repository object. */
const RECORDED_COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'

/** The facts a community build reports, including the commit its packaging run recorded. */
const COMMUNITY: CommunityVersionIdentity = {
  version: 'v0.2-dev',
  upstreamBase: 'dsh-v0.1.7-rc.2',
  upstreamCommit: RECORDED_COMMIT,
}

/** The same facts on a build whose packaging run could not resolve the base tag. */
const COMMUNITY_WITHOUT_COMMIT: CommunityVersionIdentity = {
  version: COMMUNITY.version,
  upstreamBase: COMMUNITY.upstreamBase,
}

/** The two languages the shell ships, for the cases that must hold in both. */
const LANGUAGES = [en, zh] as const

/** The facts one About surface is rendering. */
function about(overrides: Partial<DesktopAboutVersions> = {}): DesktopAboutVersions {
  return { build: '0.1.7-rc.2', community: COMMUNITY, ...overrides }
}

describe('the About detail of a build with no community metadata', () => {
  it('is the version line it has always shown, with the build version interpolated', () => {
    expect(desktopAboutDetail(en, about({ build: '1.2.3', community: undefined }))).toBe('Version V1.2.3')
  })

  it('renders the release line, not half a community block, when the metadata could not be read', () => {
    // A community build that read no metadata is byte-for-byte a release build on this surface, and
    // that is the point: half a block would imply the fork knew its base when it did not.
    expect(desktopAboutDetail(en, { build: '0.1.7-rc.2', community: undefined })).toBe('Version V0.1.7-rc.2')
  })

  it('carries no community wording at all, in either language', () => {
    for (const messages of LANGUAGES) {
      const detail = desktopAboutDetail(messages, about({ community: undefined }))
      expect(detail.split('\n')).toHaveLength(1)
      expect(detail).not.toContain(COMMUNITY.version)
      expect(detail).not.toContain(COMMUNITY.upstreamBase)
      expect(detail).not.toContain(RECORDED_COMMIT)
    }
  })
})

describe('the About detail of a community build', () => {
  it('names the identity badge, both version series, the build, and both update facts, one per line', () => {
    expect(desktopAboutDetail(en, about({ build: '0.1.7-rc.2.20261004.1' }))).toBe([
      'COMMUNITY',
      'Community version v0.2-dev',
      'Upstream base dsh-v0.1.7-rc.2',
      `Upstream commit ${RECORDED_COMMIT}`,
      'Build 0.1.7-rc.2.20261004.1',
      'Update channel Development',
      'Update status: Community updates are checked on request from the application menu',
    ].join('\n'))
  })

  it('leaves the commit line out when the build recorded none, instead of rendering an empty one', () => {
    const detail = desktopAboutDetail(en, about({ community: COMMUNITY_WITHOUT_COMMIT }))
    expect(detail.split('\n')).toEqual([
      'COMMUNITY',
      'Community version v0.2-dev',
      'Upstream base dsh-v0.1.7-rc.2',
      'Build 0.1.7-rc.2',
      'Update channel Development',
      'Update status: Community updates are checked on request from the application menu',
    ])
    expect(detail).not.toContain('Upstream commit')
  })

  it('reports the channel the version line itself declares, never a second declared fact', () => {
    // The fork's release line is the bare version. A build on it must say Release without any other
    // field changing, which is what makes the channel impossible to disagree with the version.
    const released: CommunityVersionIdentity = { ...COMMUNITY, version: 'v0.2' }
    expect(desktopAboutDetail(en, about({ community: released }))).toContain('Update channel Release')
  })

  it('says updates are checked on request rather than claiming a check already happened', () => {
    for (const version of ['v0.2-dev', 'v0.2']) {
      const detail = desktopAboutDetail(en, about({ community: { ...COMMUNITY, version } }))
      expect(detail).toContain('Update status: Community updates are checked on request')
      // About reports what the build is; it never reports the result of a comparison nobody ran.
      expect(detail).not.toMatch(/up to date|Check for updates/iu)
    }
  })

  it('keeps the community version apart from the build the application reports', () => {
    const lines = desktopAboutDetail(en, about({ build: '0.1.7-rc.2' })).split('\n')
    expect(lines).toContain('Community version v0.2-dev')
    expect(lines).toContain('Build 0.1.7-rc.2')
    // A community build names one version per series; the release line does not survive beside them.
    expect(lines.some(line => line.startsWith('Version V'))).toBe(false)
  })

  it('says the same thing in the shell\'s other language, with every fact intact', () => {
    const detail = desktopAboutDetail(zh, about())
    expect(detail.split('\n')).toHaveLength(7)
    for (const fact of [COMMUNITY.version, COMMUNITY.upstreamBase, RECORDED_COMMIT, '0.1.7-rc.2']) {
      expect(detail).toContain(fact)
    }
    // The English wording is gone, which is what proves the copy came from the dictionary.
    expect(detail).not.toMatch(/Community version|Upstream base|Upstream commit|Build |Update channel|Update status/u)
  })

  it('drops the same line in the shell\'s other language, keeping every fact that remains', () => {
    const detail = desktopAboutDetail(zh, about({ community: COMMUNITY_WITHOUT_COMMIT }))
    expect(detail.split('\n')).toHaveLength(6)
    for (const fact of [COMMUNITY.version, COMMUNITY.upstreamBase, '0.1.7-rc.2']) expect(detail).toContain(fact)
    expect(detail).not.toMatch(/Upstream commit/u)
  })
})
