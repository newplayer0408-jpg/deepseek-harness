/**
 * The version lines an About surface shows.
 *
 * About is where a user reads what they are running, and a community build has two version series to
 * report: the fork's own product version, and the upstream base it was synced to. This module is the
 * one place that turns those facts into text, so the shell's message box stays a single call, the
 * release build keeps the one line it has always shown, and no other module has to know how the
 * lines are worded.
 *
 * It holds no user-visible string of its own — every word arrives from `locale.ts` — which is what
 * keeps the About detail in the same language as the dialog chrome around it, and what keeps this
 * module out of the translation-pairing surface it would otherwise need.
 *
 * A community build that could not read its version file renders the release line alone, which is
 * exactly what a release renders. Degrading to less information is the right failure here: an
 * installation must not refuse to start, and must not invent a version, because its own metadata
 * file is missing.
 */

import type { CommunityVersionIdentity } from './community-version.ts'
import { COMMUNITY_UPDATE_CHANNEL_DEVELOPMENT, communityUpdateChannel } from './community-update.ts'
import type { DesktopMessages } from './locale.ts'
import { formatDesktopMessage } from './locale.ts'

/** What one About surface knows about the build it belongs to. */
export interface DesktopAboutVersions {
  /** Version the installed application reports, which is the build version when packaging set one. */
  readonly build: string
  /**
   * The fork's version facts, or undefined on a release build and on a community build that read
   * none. It is required-but-undefined rather than optional, so a caller has to state which case it
   * is in rather than omitting the field and getting the release wording by accident.
   */
  readonly community: CommunityVersionIdentity | undefined
}

/**
 * Render the About detail text for the build that is running.
 *
 * A release and a development build get the release line alone, unchanged. A community build gets an
 * identity badge, its product version, the upstream base tag it was synced to, the commit that tag
 * named when the build recorded one, the build it installed, and then the two update facts a
 * community user needs: which channel this installation follows, and that a Community update is
 * checked on request rather than installed in the background. The last two belong here rather than in
 * an updater dialog because this is the surface that answers "what am I running".
 *
 * The commit line is left out rather than blanked when the build recorded none, because the tag is
 * what the fork declares and the commit is derived from it: a build that could not resolve the tag
 * still knows its base, and a line naming nothing would read as a commit it does not have.
 * @param messages - the shell copy for the current UI language.
 * @param versions - the running build version, plus the fork's version facts when it has them.
 * @returns the detail text, one fact per line.
 */
export function desktopAboutDetail(messages: DesktopMessages, versions: DesktopAboutVersions): string {
  const community = versions.community
  if (community === undefined) return formatDesktopMessage(messages.aboutVersion, { version: versions.build })
  const commit = community.upstreamCommit
  // The channel is read from the version the build reports, so the line can never disagree with the
  // version line above it. An unreadable version yields no identity at all, which is why the
  // release wording is the fallback here rather than a channel the build never declared.
  const channel = communityUpdateChannel(community) === COMMUNITY_UPDATE_CHANNEL_DEVELOPMENT
    ? messages.aboutUpdateChannelDevelopment
    : messages.aboutUpdateChannelRelease
  return [
    messages.communityBadge,
    formatDesktopMessage(messages.aboutCommunityVersion, { version: community.version }),
    formatDesktopMessage(messages.aboutUpstreamBase, { version: community.upstreamBase }),
    ...commit === undefined ? [] : [formatDesktopMessage(messages.aboutUpstreamCommit, { commit })],
    formatDesktopMessage(messages.aboutBuild, { version: versions.build }),
    formatDesktopMessage(messages.aboutUpdateChannel, { channel }),
    messages.aboutUpdateStatusManual,
  ].join('\n')
}
