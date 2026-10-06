/**
 * The Community fork's own update semantics.
 *
 * A community build and a release build ship from different places, so they must not share one
 * update story. This module is the one place that states which of the two a running installation is,
 * and it states it as a pair of separate concepts:
 *
 * - **Community update** — the fork's own releases. A community build receives nothing from the
 *   official DeepSeek feed, and reading that feed would offer the user a *different product*.
 * - **Upstream status** — which upstream tag the fork was synced to. It is a fact about what this
 *   build is, never something to install, and it is reported by the version facts beside this
 *   module rather than by any updater.
 *
 * Keeping the split here rather than inside `main.ts` is what makes it testable without Electron and
 * what keeps a future change honest: a build that hands the upstream updater to a community
 * installation has to contradict this table first.
 *
 * The channel is deliberately *not* a promise about a feed. The fork's development line
 * (`v0.2-dev`) and its release line (`v0.2`) both have no Community release feed yet, so the
 * channel says which series an installation follows, and the shell's copy states availability
 * separately. Inventing an availability flag that no release path can set would be the same lie the
 * upstream updater used to tell.
 */

import { DESKTOP_COMMUNITY_VARIANT, type DesktopVariant } from './desktop-variant.ts'
import type { CommunityVersionIdentity } from './community-version.ts'

/** Channel the fork is still building towards its first release on. */
export const COMMUNITY_UPDATE_CHANNEL_DEVELOPMENT = 'development'

/** Channel the fork's own released line follows. */
export const COMMUNITY_UPDATE_CHANNEL_RELEASE = 'release'

/** The series a community installation follows, which selects the copy its shell shows. */
export type CommunityUpdateChannel =
  | typeof COMMUNITY_UPDATE_CHANNEL_DEVELOPMENT
  | typeof COMMUNITY_UPDATE_CHANNEL_RELEASE

/**
 * Which update surfaces one installation owns.
 *
 * Both directions are stated rather than one being assumed: a surface table that only enumerated the
 * community case would let a release gain a Community Diagnostics entry by default.
 */
export interface CommunityUpdateSurfaces {
  /**
   * Whether the installation is community-managed, which is the state the update copy describes.
   */
  readonly communityManaged: boolean
  /**
   * Whether the official updater is this installation's update mechanism.
   *
   * A community build answers `false`: it has no feed, and reaching upstream's check would either
   * fail with a message about a check that was never possible or, worse, offer to install the
   * official product over this one.
   */
  readonly upstreamUpdate: boolean
  /** Whether the application menu carries the Community Diagnostics entry. */
  readonly diagnosticsEntry: boolean
}

/**
 * Resolve which update surfaces an installation owns.
 * @param variant - Product variant the assembled manifest declared.
 * @returns the surface table for that variant, with no surface left implicit.
 */
export function resolveCommunityUpdateSurfaces(variant: DesktopVariant): CommunityUpdateSurfaces {
  const communityManaged = variant === DESKTOP_COMMUNITY_VARIANT
  return { communityManaged, upstreamUpdate: !communityManaged, diagnosticsEntry: communityManaged }
}

/**
 * Resolve the update channel a community installation follows.
 *
 * The community product version carries the answer: the fork's release workflow tags the bare
 * version (`v0.2`), while the development line is published with a prerelease suffix (`v0.2-dev`).
 * Reading it from the version rather than from a second declared field keeps one fact in one place —
 * a build cannot follow the release channel while naming itself a development build.
 * @param identity - the fork's version facts, or undefined on a build that read none.
 * @returns the channel, or undefined when the build declares no community version at all.
 */
export function communityUpdateChannel(identity: CommunityVersionIdentity | undefined): CommunityUpdateChannel | undefined {
  if (identity === undefined) return undefined
  return identity.version.includes('-') ? COMMUNITY_UPDATE_CHANNEL_DEVELOPMENT : COMMUNITY_UPDATE_CHANNEL_RELEASE
}
