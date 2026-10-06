/**
 * The Community fork's own version facts: its product version, and the upstream base it was synced
 * to.
 *
 * The fork carries two version series that move independently, and keeping them apart is the whole
 * point of this module. Upstream owns the package version in `apps/desktop/package.json`, and a
 * community build packages it unchanged — a fork release does not re-version upstream's packages.
 * What belongs to the fork is a product version of its own (`v0.2-dev` while it is being developed,
 * `v0.2` when it ships) together with the upstream tag it was last synced to. Those facts live in
 * exactly one committed file, so the About surface, the diagnostics report, and the release workflow
 * cannot disagree about them, and no version is transcribed into a second place where it can rot.
 *
 * The commit behind that tag is deliberately not one of them. A hash in a committed file is a
 * repository reference that drifts as soon as the tag moves or the history is rewritten, which is
 * what `scripts/verify-repository-references.ts` keeps out of maintained sources. So the file
 * records the tag, the packaging run derives the commit from the checkout it is building
 * (`scripts/community-upstream-commit.mjs`), and the assembled manifest carries the result beside
 * the variant. This module reads both, and keeps the commit optional: a build whose packaging run
 * could not resolve the tag names its version and its base without inventing a commit.
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
 * Assembled-manifest field a packaging run writes with the commit the declared upstream base named.
 *
 * `scripts/community-upstream-commit.mjs` declares the same field name for the writer. The two
 * layers own their own spelling for the same reason `dshDesktopVariant` is spelled in both: a build
 * script cannot import the bundled application source.
 */
export const UPSTREAM_COMMIT_METADATA = 'dshUpstreamCommit'

/**
 * The version facts a community build reports about itself.
 *
 * Each describes what the build *is*, never what it is planned to become: the upstream base names
 * the tag this fork is currently synced to, and the next sync is what changes it. A build that
 * recorded its sync target here would claim a merge that never happened.
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
  /**
   * Commit the declared upstream base named, when the running build recorded one.
   *
   * It is absent on a build whose packaging run could not resolve the tag, and on any run that
   * assembled no manifest — an unpackaged development session, which claims no community variant at
   * all. Nothing renders a placeholder for it: a surface short of a fact says less rather than
   * naming a commit that is not the one it packages.
   */
  readonly upstreamCommit?: string
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
 *
 * A file that declares a commit — under either the name this module reads from a manifest or the
 * one it used to read from the file — is refused outright, whatever the value. The commit is now
 * derived from the tag at packaging time, and accepting one here would let a stale hash back into
 * tracked source, where it silently stops describing the base the tag names. The refusal is what
 * makes the retired shape fail loudly instead of winning.
 * @param source - the parsed file contents.
 * @returns the identity, or undefined when any field is missing or malformed.
 */
export function parseCommunityVersion(source: unknown): CommunityVersionIdentity | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  if (UPSTREAM_COMMIT_METADATA in source || 'upstreamCommit' in source) return undefined
  if (!('communityVersion' in source) || !('upstreamBase' in source)) return undefined
  const { communityVersion, upstreamBase } = source
  if (typeof communityVersion !== 'string' || !SAFE_PRODUCT_VERSION.test(communityVersion)) return undefined
  if (typeof upstreamBase !== 'string' || !SAFE_UPSTREAM_BASE.test(upstreamBase)) return undefined
  return { version: `v${communityVersion}`, upstreamBase }
}

/**
 * Read the commit a packaging run recorded, out of the assembled manifest.
 *
 * Unreadable metadata degrades to no commit rather than to no identity: the manifest is a second
 * file, and a build that can name its version and base should still do so when only this field is
 * absent or malformed.
 * @param manifest - the parsed assembled manifest.
 * @returns the recorded commit, or undefined when none was recorded.
 */
function recordedUpstreamCommit(manifest: unknown): string | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const recorded = (manifest as Record<string, unknown>)[UPSTREAM_COMMIT_METADATA]
  return typeof recorded === 'string' && SAFE_UPSTREAM_COMMIT.test(recorded) ? recorded : undefined
}

/**
 * Read the version facts one installation declares, if it declares any.
 *
 * The variant is consulted before either file is opened, so a build that does not claim the
 * community variant reads nothing at all: a release installation has no community version to report,
 * and it must not be able to report one even if a stray file were left beside it.
 * @param options - the application path the variant bootstrap resolved, the declared variant, and optional read seams.
 * @returns the declared identity, or undefined for a non-community variant or an unreadable file.
 */
export async function readCommunityVersion(options: {
  readonly appPath: string
  readonly variant: DesktopVariant
  readonly read?: (path: string) => Promise<string>
  readonly readManifest?: (path: string) => Promise<string>
}): Promise<CommunityVersionIdentity | undefined> {
  if (options.variant !== DESKTOP_COMMUNITY_VARIANT) return undefined
  const read = options.read ?? (async (path: string): Promise<string> => readFile(path, 'utf8'))
  let text: string
  try {
    text = await read(join(options.appPath, COMMUNITY_VERSION_FILE))
  } catch {
    return undefined
  }
  let identity: CommunityVersionIdentity | undefined
  try {
    identity = parseCommunityVersion(JSON.parse(text))
  } catch {
    return undefined
  }
  if (identity === undefined) return undefined
  const readManifest = options.readManifest ?? (async (path: string): Promise<string> => readFile(path, 'utf8'))
  let manifest: unknown
  try {
    manifest = JSON.parse(await readManifest(join(options.appPath, 'package.json')))
  } catch {
    return identity
  }
  const commit = recordedUpstreamCommit(manifest)
  return commit === undefined ? identity : { ...identity, upstreamCommit: commit }
}
