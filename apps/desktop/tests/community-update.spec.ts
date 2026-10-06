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
