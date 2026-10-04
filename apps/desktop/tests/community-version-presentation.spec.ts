/**
 * About is where a user reads what they are running, and it is the one surface where the two version
 * series meet: the line a release has always shown survives unchanged, and a community build shows its
 * own version beside the upstream base it was synced to.
 *
 * These cases pin all three directions. A release build must not acquire community wording, a
 * community build must name the fork's version without losing the build it packages, and the wording
 * must come from the locale dictionary rather than from this module — a hardcoded line would pass an
 * English-only assertion and ship a Chinese user an English dialog.
 */
import { describe, expect, it } from 'vitest'
import type { CommunityVersionIdentity } from '../src/community-version.ts'
import { desktopAboutDetail, type DesktopAboutVersions } from '../src/community-version-presentation.ts'
import { en, zh } from '../src/locale.ts'

/** The facts a community build reads from its own metadata file. */
const COMMUNITY: CommunityVersionIdentity = {
  version: 'v0.2-dev',
  upstreamBase: 'dsh-v0.1.7-rc.2',
  upstreamCommit: '477b4f420553e8a52c2fbccc464d7561b239c443',
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
      expect(detail).not.toContain(COMMUNITY.upstreamCommit)
    }
  })
})

describe('the About detail of a community build', () => {
  it('names the community version, the upstream base and commit, and the build, one per line', () => {
    expect(desktopAboutDetail(en, about({ build: '0.1.7-rc.2.20261004.1' }))).toBe([
      'Community version v0.2-dev',
      'Upstream base dsh-v0.1.7-rc.2',
      'Upstream commit 477b4f420553e8a52c2fbccc464d7561b239c443',
      'Build 0.1.7-rc.2.20261004.1',
    ].join('\n'))
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
    expect(detail.split('\n')).toHaveLength(4)
    for (const fact of [COMMUNITY.version, COMMUNITY.upstreamBase, COMMUNITY.upstreamCommit, '0.1.7-rc.2']) {
      expect(detail).toContain(fact)
    }
    // The English wording is gone, which is what proves the copy came from the dictionary.
    expect(detail).not.toMatch(/Community version|Upstream base|Upstream commit|Build /u)
  })
})
