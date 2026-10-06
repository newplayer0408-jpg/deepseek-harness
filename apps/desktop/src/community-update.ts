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

/**
 * One parsed Community version.
 *
 * The fork versions itself on `major.minor[.patch]`, with an optional dot-separated prerelease, and
 * this is the shape every comparison below reads. Parsing and comparing are separate steps so a
 * caller can refuse a version it does not recognize without inventing an ordering for it.
 */
export interface CommunitySemver {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** Dot-separated prerelease identifiers; empty on a release version. */
  readonly prerelease: readonly string[]
}

/** A Community version, with or without the leading `v` and with an optional prerelease. */
const SAFE_SEMVER = /^v?(\d{1,4})(?:\.(\d{1,5}))?(?:\.(\d{1,5}))?(?:-([A-Za-z0-9.]{1,32}))?$/u

/** One prerelease identifier that is a number, as SemVer orders it against an alphanumeric one. */
const NUMERIC_IDENTIFIER = /^\d{1,9}$/u

/**
 * Parse a Community version.
 *
 * A value outside the grammar answers undefined rather than a best-effort reading: a version the
 * comparator did not recognize would otherwise be compared as if it were zero, and "0.0.0 is newer
 * than your build" is the kind of answer that offers a downgrade.
 * @param value - the version as a user-facing string, such as `v0.2` or `0.4-rc.1`.
 * @returns the parsed version, or undefined when it is not one.
 */
export function parseCommunityVersion(value: string): CommunitySemver | undefined {
  const match = SAFE_SEMVER.exec(value.trim())
  if (match === null) return undefined
  const [, major, minor, patch, prerelease] = match
  return {
    major: Number(major),
    minor: minor === undefined ? 0 : Number(minor),
    patch: patch === undefined ? 0 : Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  }
}

/**
 * Order two prerelease identifier lists, as SemVer orders them.
 *
 * A release outranks any prerelease of the same version, a numeric identifier ranks below an
 * alphanumeric one, and a shorter list that is a prefix of a longer one ranks first. Spellings are
 * compared as they arrived rather than folded to one case: the fork writes its prereleases in lower
 * case, and inventing an equivalence the release workflow does not produce would only hide a typo.
 * @param left - prerelease identifiers of the left version.
 * @param right - prerelease identifiers of the right version.
 * @returns negative when `left` ranks first, positive when `right` does, zero when they are equal.
 */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0) return right.length === 0 ? 0 : 1
  if (right.length === 0) return -1
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index] ?? ''
    const b = right[index] ?? ''
    if (a === b) continue
    const aNumeric = NUMERIC_IDENTIFIER.test(a)
    const bNumeric = NUMERIC_IDENTIFIER.test(b)
    if (aNumeric && bNumeric) return Number(a) - Number(b)
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : 1
  }
  return left.length - right.length
}

/**
 * Order two Community versions.
 * @param left - the version to place.
 * @param right - the version to compare against.
 * @returns negative when `left` is older, positive when it is newer, zero when they are the same version.
 */
export function compareCommunityVersions(left: CommunitySemver, right: CommunitySemver): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * Whether a check result is a Community version worth asking the user to install.
 *
 * The two lines are kept apart in both directions. A stable installation refuses every prerelease, so
 * `0.4-rc.1` is never offered as a stable update; and a development installation refuses every
 * release, so the `0.2-dev` build a developer is running is never silently replaced by `0.2`. That
 * second rule is the conservative one: a stable installer carries a released product, and a user on
 * the development line asked for the development line.
 *
 * A version either side cannot parse answers `false`. The comparison is the one thing here that would
 * otherwise guess, and guessing is what turns a malformed manifest into an offered upgrade.
 * @param localVersion - the version this installation reports.
 * @param remoteVersion - the version a checked manifest offers.
 * @returns whether the offered version should be presented as an available update.
 */
export function isCommunityUpdateAvailable(localVersion: string, remoteVersion: string): boolean {
  const local = parseCommunityVersion(localVersion)
  const remote = parseCommunityVersion(remoteVersion)
  if (local === undefined || remote === undefined) return false
  if ((local.prerelease.length === 0) !== (remote.prerelease.length === 0)) return false
  return compareCommunityVersions(remote, local) > 0
}
