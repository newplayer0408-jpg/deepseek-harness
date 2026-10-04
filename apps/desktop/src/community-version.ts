/**
 * The Community fork's own version facts: its product version, and the upstream base it was synced
 * to.
 *
 * The fork carries two version series that move independently, and keeping them apart is the whole
 * point of this module. Upstream owns the package version in `apps/desktop/package.json`, and a
 * community build packages it unchanged — a fork release does not re-version upstream's packages.
 * What belongs to the fork is a product version of its own (`v0.2-dev` while it is being developed,
 * `v0.2` when it ships) together with the upstream tag and commit it was last synced to. Those three
 * facts live in exactly one committed file, so the About surface, the diagnostics report, and the
 * release workflow cannot disagree about them, and no version is transcribed into a second place
 * where it can rot.
 *
 * The file is read rather than imported, for two reasons. `tsconfig.base.json` does not enable
 * `resolveJsonModule`, so a JSON import would not typecheck; and an import would place the file in
 * the same module graph the isolated preload is bundled from, where a Node-only reader is exactly
 * what must not appear. Reading it through the `appPath` the variant bootstrap already resolved
 * keeps one file and one reader, in the main process only.
 *
 * A fact that cannot be read is never a reason to fail a startup. An absent file, a truncated one, a
 * value outside its shape, a read that throws — each answers `undefined`, so the About surface says
 * less and the diagnostics report names what is missing, instead of an installation refusing to run
 * because its own changelog metadata is malformed.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DESKTOP_COMMUNITY_VARIANT, type DesktopVariant } from './desktop-variant.ts'

/** Name of the committed file that holds the fork's version facts, beside `package.json`. */
export const COMMUNITY_VERSION_FILE = 'community-version.json'

/**
 * The three version facts a community build declares about itself.
 *
 * Every one of them describes what the build *is*, never what it is planned to become: the upstream
 * base names the tag this fork is currently synced to, and the next sync is what changes it. A
 * build that recorded its sync target here would claim a merge that never happened.
 */
export interface CommunityVersionIdentity {
  /**
   * Community product version in the form a user reads, such as `v0.2-dev`.
   *
   * It carries the leading `v` because this is the product-facing spelling, and the release workflow
   * names its tag from the same value; the file itself stores the bare form.
   */
  readonly version: string
  /** Upstream release tag this fork was last synced to, as upstream names it: `dsh-v0.1.7-rc.2`. */
  readonly upstreamBase: string
  /** Full commit that upstream tag named, so the base is a commit rather than a moving tag. */
  readonly upstreamCommit: string
}

/** A product version as the file stores one: bare and dot-separated, with no leading `v`. */
const SAFE_PRODUCT_VERSION = /^\d{1,4}(?:\.\d{1,5}){0,2}(?:-[A-Za-z0-9.]{1,32})?$/u

/** An upstream release tag, as upstream names one. */
const SAFE_UPSTREAM_BASE = /^dsh-v\d{1,4}(?:\.\d{1,5}){0,2}(?:-[A-Za-z0-9.]{1,32})?$/u

/** A full commit hash, as `git rev-parse` prints one. */
const SAFE_UPSTREAM_COMMIT = /^[0-9a-f]{40}$/u

/**
 * Read the fork's version facts out of whatever the file parsed to.
 *
 * The parameter is unknown on purpose: the file is on disk and can be edited by hand, so every field
 * is treated as untrusted text and gated against the shape its source really produces. A field
 * outside its shape makes the whole identity unavailable rather than being rendered on its own,
 * because "the version file is half right" is not a state any surface should have to describe.
 * @param source - the parsed file contents.
 * @returns the identity, or undefined when any field is missing or malformed.
 */
export function parseCommunityVersion(source: unknown): CommunityVersionIdentity | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  if (!('communityVersion' in source) || !('upstreamBase' in source) || !('upstreamCommit' in source)) return undefined
  const { communityVersion, upstreamBase, upstreamCommit } = source
  if (typeof communityVersion !== 'string' || !SAFE_PRODUCT_VERSION.test(communityVersion)) return undefined
  if (typeof upstreamBase !== 'string' || !SAFE_UPSTREAM_BASE.test(upstreamBase)) return undefined
  if (typeof upstreamCommit !== 'string' || !SAFE_UPSTREAM_COMMIT.test(upstreamCommit)) return undefined
  return { version: `v${communityVersion}`, upstreamBase, upstreamCommit }
}

/**
 * Read the version facts one installation declares, if it declares any.
 *
 * The variant is consulted before the file is opened, so a build that does not claim the community
 * variant reads nothing at all: a release installation has no community version to report, and it
 * must not be able to report one even if a stray file were left beside it.
 * @param options - the application path the variant bootstrap resolved, the declared variant, and an optional read seam.
 * @returns the declared identity, or undefined for a non-community variant or an unreadable file.
 */
export async function readCommunityVersion(options: {
  readonly appPath: string
  readonly variant: DesktopVariant
  readonly read?: (path: string) => Promise<string>
}): Promise<CommunityVersionIdentity | undefined> {
  if (options.variant !== DESKTOP_COMMUNITY_VARIANT) return undefined
  const read = options.read ?? (async (path: string): Promise<string> => readFile(path, 'utf8'))
  let text: string
  try {
    text = await read(join(options.appPath, COMMUNITY_VERSION_FILE))
  } catch {
    return undefined
  }
  try {
    return parseCommunityVersion(JSON.parse(text))
  } catch {
    return undefined
  }
}
