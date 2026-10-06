/**
 * Which update surfaces a build owns, and which channel a community installation follows.
 *
 * The table is the whole point of the module: a community build must never reach the official
 * updater, and a release must never gain a Community Diagnostics entry. These cases pin both
 * directions for all three variants, so a future change that hands one build the other's surface has
 * to change an expected row here rather than slip through a wiring edit in `main.ts`.
 *
 * The renderer marker is pinned for the same reason on the other side of the boundary: only the
 * community build passes one, and the preload that reads it must never mistake a release for it.
 */
import { describe, expect, it } from 'vitest'
import {
  COMMUNITY_UPDATE_CHANNEL_DEVELOPMENT,
  COMMUNITY_UPDATE_CHANNEL_RELEASE,
  communityUpdateChannel,
  compareCommunityVersions,
  isCommunityUpdateAvailable,
  parseCommunityVersion,
  resolveCommunityUpdateSurfaces,
} from '../src/community-update.ts'
import { communityVariantArguments, isCommunityArguments } from '../src/community-variant-argument.ts'
import {
  DESKTOP_COMMUNITY_VARIANT,
  DESKTOP_DEV_VARIANT,
  DESKTOP_PRODUCTION_VARIANT,
  type DesktopVariant,
} from '../src/desktop-variant.ts'
import type { CommunityVersionIdentity } from '../src/community-version.ts'

/** The three variants a build can declare. */
const VARIANTS: readonly DesktopVariant[] = [DESKTOP_PRODUCTION_VARIANT, DESKTOP_DEV_VARIANT, DESKTOP_COMMUNITY_VARIANT]

/** The fork's development line, which is what this release lane currently publishes. */
const DEVELOPMENT: CommunityVersionIdentity = { version: 'v0.2-dev', upstreamBase: 'dsh-v0.2.0-rc.2' }

describe('update surfaces by variant', () => {
  it('gives the official updater to a release and to a development build', () => {
    for (const variant of [DESKTOP_PRODUCTION_VARIANT, DESKTOP_DEV_VARIANT] as const) {
      expect(resolveCommunityUpdateSurfaces(variant)).toEqual({
        communityManaged: false, upstreamUpdate: true, diagnosticsEntry: false,
      })
    }
  })

  it('gives a community build its own surfaces and withholds the official updater', () => {
    expect(resolveCommunityUpdateSurfaces(DESKTOP_COMMUNITY_VARIANT)).toEqual({
      communityManaged: true, upstreamUpdate: false, diagnosticsEntry: true,
    })
  })

  it('leaves no surface implicit, whatever variant is asked about', () => {
    for (const variant of VARIANTS) {
      const surfaces = resolveCommunityUpdateSurfaces(variant)
      expect(Object.keys(surfaces).sort()).toEqual(['communityManaged', 'diagnosticsEntry', 'upstreamUpdate'])
      // The two update mechanisms are exclusive: a build that owns neither would have no update
      // story, and one that owns both would have two.
      expect(surfaces.upstreamUpdate).toBe(!surfaces.communityManaged)
    }
  })

  it('never lets a community build reach upstream\'s check, for any declared variant', () => {
    // The regression this whole phase exists to prevent, stated as a property: any future table that
    // answers `true` here would offer to install the official product over a community install.
    const withUpstream = VARIANTS.filter(variant => resolveCommunityUpdateSurfaces(variant).upstreamUpdate)
    expect(withUpstream).not.toContain(DESKTOP_COMMUNITY_VARIANT)
  })
})

describe('the channel a community installation follows', () => {
  it('reads a development build out of its prerelease suffix', () => {
    expect(communityUpdateChannel(DEVELOPMENT)).toBe(COMMUNITY_UPDATE_CHANNEL_DEVELOPMENT)
    expect(communityUpdateChannel({ ...DEVELOPMENT, version: 'v0.3-rc.1' })).toBe(COMMUNITY_UPDATE_CHANNEL_DEVELOPMENT)
  })

  it('reads the fork\'s released line out of the bare version', () => {
    expect(communityUpdateChannel({ ...DEVELOPMENT, version: 'v0.2' })).toBe(COMMUNITY_UPDATE_CHANNEL_RELEASE)
  })

  it('answers nothing at all for a build that declares no community version', () => {
    expect(communityUpdateChannel(undefined)).toBeUndefined()
  })
})

describe('the renderer marker', () => {
  it('is passed by a community build and by no other', () => {
    expect(communityVariantArguments(true)).toHaveLength(1)
    expect(communityVariantArguments(false)).toEqual([])
  })

  it('is recognized only where it is present', () => {
    const argv = ['--some-other-flag', ...communityVariantArguments(true)]
    expect(isCommunityArguments(argv)).toBe(true)
    expect(isCommunityArguments(communityVariantArguments(false))).toBe(false)
    // A release's renderer arguments are the ones Electron always added; nothing may read as one.
    expect(isCommunityArguments(['electron', '.', '--no-sandbox'])).toBe(false)
  })

  it('cannot be forged by a longer argument that merely contains it', () => {
    expect(isCommunityArguments(['--dsh-desktop-variant=community-not'])).toBe(false)
  })
})

/**
 * The version semantics one Community release line has, and the four answers a check can reach.
 *
 * These cases exist because the alternative — comparing version strings — is wrong in ways that look
 * right: `'0.10' < '0.9'` as text, and `'0.2'` versus `'0.2-dev'` has no textual meaning at all. The
 * table below is written from the user's side rather than from the implementation's: what a build
 * *should* be told, for each pair of versions a release could actually produce.
 */
describe('ordering two community versions', () => {
  /** One comparison, as the sign the comparator reports. */
  function order(left: string, right: string): number {
    const a = parseCommunityVersion(left)
    const b = parseCommunityVersion(right)
    if (a === undefined || b === undefined) throw new Error(`unparseable version: ${left} / ${right}`)
    return Math.sign(compareCommunityVersions(a, b))
  }

  it('orders by major, then minor, then patch, and not as text', () => {
    expect(order('0.2', '0.3')).toBe(-1)
    expect(order('0.3', '0.3')).toBe(0)
    expect(order('0.3', '0.2')).toBe(1)
    // The case a string comparison gets backwards: ten is greater than nine.
    expect(order('0.10', '0.9')).toBe(1)
    expect(order('1.0', '0.99')).toBe(1)
    expect(order('0.2.1', '0.2.2')).toBe(-1)
    // A version with no patch is the same release as one that names a zero patch.
    expect(order('0.2', '0.2.0')).toBe(0)
  })

  it('reads a version with or without a leading v, and refuses one it cannot order', () => {
    expect(parseCommunityVersion('v0.2')).toEqual({ major: 0, minor: 2, patch: 0, prerelease: [] })
    expect(parseCommunityVersion('0.2')).toEqual(parseCommunityVersion('v0.2'))
    // The parser trims before it matches, so a padded value is the version it names rather than a
    // parse failure the caller would have to handle differently.
    expect(parseCommunityVersion(' 0.2 ')).toEqual(parseCommunityVersion('0.2'))
    for (const value of ['', 'latest', '0.2.0.0.0', 'v', 'x0.2', 'v0.2.0-', '0.2-']) {
      expect(parseCommunityVersion(value), value).toBeUndefined()
    }
  })

  it('ranks a release above any prerelease of the same version, and a numeric identifier below an alphabetic one', () => {
    expect(order('0.2', '0.2-dev')).toBe(1)
    expect(order('0.2-dev', '0.2')).toBe(-1)
    expect(order('0.3-rc.1', '0.3-rc.2')).toBe(-1)
    // SemVer's own rule, and the one a hand-written comparator usually gets wrong.
    expect(order('0.3-rc.2', '0.3-rc.10')).toBe(-1)
    expect(order('0.3-1', '0.3-alpha')).toBe(-1)
    // A shorter list that is a prefix of a longer one ranks first.
    expect(order('0.3-rc', '0.3-rc.1')).toBe(-1)
  })
})

describe('whether a checked version is an update worth offering', () => {
  it('offers a newer release to a build on the release line', () => {
    expect(isCommunityUpdateAvailable('v0.2', '0.3')).toBe(true)
    expect(isCommunityUpdateAvailable('v0.2', '0.2.1')).toBe(true)
  })

  it('treats a build already on the checked version, and an older one, as up to date', () => {
    expect(isCommunityUpdateAvailable('v0.2', '0.2')).toBe(false)
    expect(isCommunityUpdateAvailable('v0.3', '0.2')).toBe(false)
    expect(isCommunityUpdateAvailable('v0.3', '0.2.9')).toBe(false)
  })

  it('never offers a prerelease to a build on the release line', () => {
    for (const remote of ['0.4-rc.1', '0.3-dev', '0.3-beta.2']) {
      expect(isCommunityUpdateAvailable('v0.2', remote), remote).toBe(false)
    }
  })

  it('never replaces a development build with a release, however much newer the release is', () => {
    // The conservative half of the rule: a user on the development line asked for the development
    // line, so a released installer is not silently substituted for it even when it is newer.
    expect(isCommunityUpdateAvailable('v0.2-dev', '0.3')).toBe(false)
    expect(isCommunityUpdateAvailable('v0.2-dev', '0.4')).toBe(false)
    // The rule is symmetric, so a release build is not handed a prerelease either.
    expect(isCommunityUpdateAvailable('v0.2', '0.3-dev')).toBe(false)
  })

  it('would offer a newer development build, and no published channel can deliver one yet', () => {
    // The comparison itself is line-relative, so two development versions are ordered normally. The
    // reason this is not reachable today is the manifest: it exists only for the stable channel and
    // refuses a prerelease version outright, which is pinned in the manifest and service specs.
    expect(isCommunityUpdateAvailable('v0.2-dev', '0.3-dev')).toBe(true)
    expect(isCommunityUpdateAvailable('v0.3-dev', '0.2-dev')).toBe(false)
    expect(isCommunityUpdateAvailable('v0.2-dev', 'v0.2-dev')).toBe(false)
  })

  it('refuses to answer when either version is one it cannot order', () => {
    // Guessing here is what would turn a malformed manifest into an offered upgrade.
    for (const [local, remote] of [['v0.2', 'latest'], ['latest', '0.3'], ['v0.2', ''], ['', '0.3']] as const) {
      expect(isCommunityUpdateAvailable(local, remote), `${local} / ${remote}`).toBe(false)
    }
  })
})
