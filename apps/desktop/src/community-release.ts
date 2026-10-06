/**
 * The fork's own release identity: which GitHub repository publishes Community releases, and where
 * its update manifest lives.
 *
 * A Community installation updates from the fork that built it, never from DeepSeek's own release
 * infrastructure, so the update code needs one answer to "which repository is mine". That answer is
 * configuration rather than a constant in a module for two reasons. It differs from the upstream
 * repository the sources were synced from, and a value in the code is invisible to the release
 * tooling that has to build the same URLs; a committed file is read by both the packaged application
 * and `scripts/community-release-manifest.ts`, so a published manifest and the client looking for it
 * cannot drift apart.
 *
 * The file was written from the fork's own remote, not from a guess: `git remote -v` names
 * `origin = https://github.com/newplayer0408-jpg/deepseek-harness.git` and
 * `upstream = https://github.com/deepseek-ai/deepseek-harness.git`, and only the former is this
 * fork's release source. It is deliberately *not* derived from `COMMUNITY_APP_ID`
 * (`io.github.newplayer0408.deepseek-harness`): the identifier names a reverse-DNS namespace pinned
 * when the variant was introduced, and its second label does not name the GitHub account that holds
 * this fork, so treating it as a repository locator would send every installation to a repository
 * that may not be this one.
 *
 * Two shapes are gated here rather than at their call sites. A repository is an `owner/name` pair
 * with GitHub's own character set, so a hand-edited file cannot turn its contents into URL path
 * segments or into a different host; and a URL the update code will ask for must be one the declared
 * repository itself owns. Both are what keep a manifest from redirecting the update chain to a
 * repository nobody reviewed.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DESKTOP_COMMUNITY_VARIANT, type DesktopVariant } from './desktop-variant.ts'

/** Name of the committed file that declares the fork's release identity, beside `package.json`. */
export const COMMUNITY_RELEASE_FILE = 'community-release.json'

/** Host that serves a repository's release pages and its `latest/download` redirects. */
export const COMMUNITY_RELEASE_HOST = 'github.com'

/**
 * Hosts GitHub redirects a release asset download to.
 *
 * GitHub serves release assets from a content host rather than from `github.com`, and the exact name
 * has changed over time, so the set names each host the service has used. Membership is what a
 * redirect is checked against; it is never a fallback for "any host that is not ours".
 */
export const COMMUNITY_ASSET_HOSTS = [
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
] as const

/** Prefix the fork's own release tags carry, so a Community tag is never read as an upstream one. */
export const COMMUNITY_RELEASE_TAG_PREFIX = 'community-v'

/** A GitHub `owner/name` repository pair, using each part's own character set. */
const SAFE_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u

/** A manifest file name: one flat JSON file directly inside the release asset directory. */
const SAFE_MANIFEST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/u

/** A Community release tag, as the fork's release workflow names one. */
const SAFE_RELEASE_TAG = /^community-v\d{1,4}(?:\.\d{1,5}){0,2}$/u

/** A Windows installer asset name, as the fork's packaging names one. */
const SAFE_ASSET_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.exe$/u

/**
 * The repository one fork publishes from, and the manifest it publishes there.
 *
 * Both are facts about the fork rather than about a specific release, so neither changes when a new
 * version ships.
 */
export interface CommunityReleaseIdentity {
  /** GitHub repository in `owner/name` form; the only repository this installation may download from. */
  readonly repository: string
  /** Manifest file name published as a release asset of that repository. */
  readonly manifest: string
}

/**
 * What one URL is, relative to a declared repository.
 *
 * `unknown` is a value rather than a throw: a URL that is not the repository's is exactly the case a
 * caller has to refuse, and naming that outcome keeps the refusal testable.
 */
export type CommunityReleaseOrigin =
  | 'manifest'
  | 'asset'
  | 'release-page'
  | 'asset-host'
  | 'unknown'

/**
 * Read the fork's release identity out of whatever the file parsed to.
 *
 * The parameter is unknown on purpose: the file is on disk and can be edited by hand, so every field
 * is treated as untrusted text and gated against the shape its source really produces. A value
 * outside its shape makes the whole identity unavailable rather than being used on its own, because
 * half a repository pair is not a location any download may be started from.
 * @param source - the parsed file contents.
 * @returns the identity, or undefined when any field is missing or malformed.
 */
export function parseCommunityRelease(source: unknown): CommunityReleaseIdentity | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const { repository, manifest } = source as { readonly repository?: unknown; readonly manifest?: unknown }
  if (typeof repository !== 'string' || !SAFE_REPOSITORY.test(repository)) return undefined
  if (typeof manifest !== 'string' || !SAFE_MANIFEST.test(manifest)) return undefined
  return { repository, manifest }
}

/**
 * Read the release identity one installation declares, if it declares any.
 *
 * The variant is consulted before the file is opened, so a build that does not claim the community
 * variant reads nothing at all: a release installation has no Community release source, and it must
 * not be able to acquire one even if the file were left beside it. A file that cannot be read
 * answers undefined rather than failing a startup, exactly as the version facts do.
 * @param options - the application path the variant bootstrap resolved, the declared variant, and an optional read seam.
 * @returns the declared identity, or undefined for a non-community variant or an unreadable file.
 */
export async function readCommunityRelease(options: {
  readonly appPath: string
  readonly variant: DesktopVariant
  readonly read?: (path: string) => Promise<string>
}): Promise<CommunityReleaseIdentity | undefined> {
  if (options.variant !== DESKTOP_COMMUNITY_VARIANT) return undefined
  const read = options.read ?? (async (path: string): Promise<string> => readFile(path, 'utf8'))
  try {
    return parseCommunityRelease(JSON.parse(await read(join(options.appPath, COMMUNITY_RELEASE_FILE))))
  } catch {
    return undefined
  }
}

/**
 * The stable address the update manifest is read from.
 *
 * `releases/latest/download` is GitHub's own redirect to the newest asset of that name, which is what
 * makes the address stable across releases without the client parsing any HTML or calling an API. The
 * path is built from the declared repository, so no release name and no query parameter can point it
 * at a different one.
 * @param identity - the fork's release identity.
 * @returns the manifest URL.
 */
export function communityManifestUrl(identity: CommunityReleaseIdentity): string {
  return `https://${COMMUNITY_RELEASE_HOST}/${identity.repository}/releases/latest/download/${identity.manifest}`
}

/**
 * The address one named installer is published at, inside one release.
 *
 * The manifest records this form so a client can verify the download it is about to start is the
 * repository's own asset; the release name is gated before it reaches the path.
 * @param identity - the fork's release identity.
 * @param tag - Community release tag, such as `community-v0.2`.
 * @param fileName - installer asset name.
 * @returns the asset URL, or undefined when the tag or name is outside its shape.
 */
export function communityAssetUrl(
  identity: CommunityReleaseIdentity,
  tag: string,
  fileName: string,
): string | undefined {
  if (!SAFE_RELEASE_TAG.test(tag) || !SAFE_ASSET_FILE.test(fileName)) return undefined
  return `https://${COMMUNITY_RELEASE_HOST}/${identity.repository}/releases/download/${tag}/${fileName}`
}

/**
 * The repository's release listing, for a user who would rather download by hand.
 * @param identity - the fork's release identity.
 * @returns the releases page URL.
 */
export function communityReleasesUrl(identity: CommunityReleaseIdentity): string {
  return `https://${COMMUNITY_RELEASE_HOST}/${identity.repository}/releases`
}

/**
 * Classify one URL against the declared repository.
 *
 * The comparison is on parsed URL parts rather than on a string prefix: a prefix test would accept
 * `https://github.com/<repo>/..%2f..%2fother` and would have to special-case case-insensitivity and
 * default ports itself. A `file:`, `http:`, or credential-bearing URL never reaches the repository
 * branch at all, which is what makes "HTTPS only" a property of this function rather than a rule each
 * caller remembers.
 * @param url - the URL to classify.
 * @param identity - the fork's release identity.
 * @returns what the URL is, relative to that repository.
 */
export function communityReleaseOrigin(url: string, identity: CommunityReleaseIdentity): CommunityReleaseOrigin {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'unknown'
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return 'unknown'
  const host = parsed.hostname.toLowerCase()
  if ((COMMUNITY_ASSET_HOSTS as readonly string[]).includes(host)) return 'asset-host'
  if (host !== COMMUNITY_RELEASE_HOST) return 'unknown'
  const segments = parsed.pathname.split('/').filter(segment => segment !== '')
  const [owner, name, section, ...rest] = segments
  if (`${owner ?? ''}/${name ?? ''}`.toLowerCase() !== identity.repository.toLowerCase()) return 'unknown'
  if (section !== 'releases') return 'unknown'
  if (rest.length === 3 && rest[0] === 'latest' && rest[1] === 'download' && rest[2] === identity.manifest) {
    return 'manifest'
  }
  if (rest.length === 3 && rest[0] === 'download') return 'asset'
  return 'release-page'
}

/**
 * Whether a download may follow one redirect.
 *
 * The policy is deliberately an allowlist with one shape rather than "follow redirects": a manifest
 * can name any URL, and a client that followed wherever it was sent would let a compromised or
 * mistyped release file move the update chain to a repository nobody reviewed. Two hops are allowed
 * and nothing else — from the repository's own release path into GitHub's asset host, and between
 * asset hosts when the service moves a download internally. The caller additionally caps the number
 * of hops, so this answers only "is this hop acceptable".
 * @param from - the URL that answered with a redirect.
 * @param to - the `location` that redirect named, as it arrived.
 * @param identity - the fork's release identity.
 * @returns whether the hop may be taken.
 */
export function communityRedirectAllowed(
  from: string,
  to: string,
  identity: CommunityReleaseIdentity,
): boolean {
  const source = communityReleaseOrigin(from, identity)
  if (source !== 'manifest' && source !== 'asset' && source !== 'asset-host') return false
  const target = communityReleaseOrigin(to, identity)
  return target === 'asset-host'
}

/**
 * Build the update manifest one release publishes.
 *
 * The release tooling and the client both need the file name and the tag, and a single derivation is
 * what keeps the published URL and the expected URL identical.
 * @param identity - the fork's release identity.
 * @param version - Community version without its leading `v`, such as `0.2`.
 * @param fileName - installer asset name.
 * @returns the tag, the asset URL, and the release page, or undefined when an input is outside its shape.
 */
export function communityReleaseLocation(
  identity: CommunityReleaseIdentity,
  version: string,
  fileName: string,
): { readonly tag: string; readonly assetUrl: string; readonly releaseUrl: string } | undefined {
  const tag = `${COMMUNITY_RELEASE_TAG_PREFIX}${version}`
  const assetUrl = communityAssetUrl(identity, tag, fileName)
  if (assetUrl === undefined) return undefined
  return { tag, assetUrl, releaseUrl: `${communityReleasesUrl(identity)}/tag/${tag}` }
}
