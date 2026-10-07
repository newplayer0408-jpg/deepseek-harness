/**
 * The Community update manifest: what a release publishes, and what a client will accept.
 *
 * The manifest exists so a client never parses a release page or calls an API to find out whether a
 * newer Community version exists. One flat JSON file names the version, the release date, the
 * upstream base it was synced to, and the exact installer for each platform — including the SHA-256
 * the downloaded bytes must hash to.
 *
 * Validation is a fail-closed reading of untrusted input, and that shapes every function here. The
 * document arrives over the network, so each field is gated against the shape the release tooling
 * really writes, and the first field that does not match makes the whole manifest invalid rather
 * than being dropped on its own — a manifest whose version is missing but whose asset is present is
 * not a manifest a client may act on. The version is checked with the same parser the comparator
 * uses, so a value this module accepts is a value the comparison can order; and a stable channel
 * refuses a prerelease version outright, which is what keeps an `-rc` build from ever being offered
 * as a stable update.
 *
 * The asset URL is checked against the declared release repository rather than merely for being
 * HTTPS: the manifest names its own download location, so a manifest that could name any host would
 * be able to move the update chain somewhere nobody reviewed.
 */

import {
  communityReleaseOrigin,
  type CommunityReleaseIdentity,
} from './community-release.ts'
import { parseCommunityVersion } from './community-update.ts'

/**
 * Schema version this client reads.
 *
 * It is validated rather than ignored: a future manifest that changed a field's meaning must be
 * refused by an old client, and the only way that can happen is if the old client checks.
 */
export const COMMUNITY_UPDATE_SCHEMA_VERSION = 1

/** Channel a release manifest declares; the fork publishes its development line elsewhere. */
export const COMMUNITY_UPDATE_STABLE_CHANNEL = 'stable'

/**
 * Upper bound on a manifest body.
 *
 * A manifest is a few hundred bytes. The bound exists so a hostile or broken response cannot make the
 * client allocate without limit before validation gets a chance to refuse it.
 */
export const COMMUNITY_UPDATE_MAX_MANIFEST_BYTES = 512 * 1024

/** One platform's installer, as the manifest publishes it. */
export interface CommunityUpdateAsset {
  /** Installer file name, as it is published in the release. */
  readonly fileName: string
  /** Full HTTPS URL of the installer inside the declared release repository. */
  readonly url: string
  /** Lowercase hexadecimal SHA-256 the downloaded bytes must hash to. */
  readonly sha256: string
  /** Declared byte size, when the release tooling recorded one. */
  readonly size?: number
}

/** One validated manifest. */
export interface CommunityUpdateManifest {
  readonly schemaVersion: number
  /** Community version without the leading `v`, exactly as the file declares it. */
  readonly version: string
  readonly channel: string
  /** Publication time as the file declares it; already known to be parseable. */
  readonly publishedAt: string
  /** Upstream tag this release was synced to. Displayed as a fact, never compared. */
  readonly upstreamBase?: string
  /** Release page a user can open for the notes. */
  readonly releaseNotesUrl?: string
  /** The installer this platform will download. */
  readonly asset: CommunityUpdateAsset
}

/**
 * Why a manifest was refused.
 *
 * Each reason is one validation step rather than one message, so the shell can report the category
 * without ever rendering text the manifest supplied.
 */
export type CommunityUpdateManifestFault =
  | 'malformed-json'
  | 'unsupported-schema'
  | 'invalid-version'
  | 'invalid-channel'
  | 'invalid-published-at'
  | 'invalid-upstream-base'
  | 'invalid-release-notes-url'
  | 'unsupported-platform'
  | 'invalid-asset'

/** The outcome of validating one manifest. */
export type CommunityUpdateManifestResult =
  | { readonly kind: 'valid'; readonly manifest: CommunityUpdateManifest }
  | { readonly kind: 'invalid'; readonly fault: CommunityUpdateManifestFault }

/** A lowercase hexadecimal SHA-256 digest. */
const SAFE_SHA256 = /^[0-9a-f]{64}$/u

/** An upstream release tag, as upstream names one. */
const SAFE_UPSTREAM_BASE = /^dsh-v\d{1,4}(?:\.\d{1,5}){0,2}(?:-[A-Za-z0-9.]{1,32})?$/u

/** Operating-system key the manifest groups a platform's installers under. */
const PLATFORM_KEYS: Readonly<Record<string, string>> = {
  win32: 'windows',
  darwin: 'macos',
  linux: 'linux',
}

/**
 * The manifest key one running platform reads its installer from.
 * @param os - `process.platform` of the running application.
 * @param arch - `process.arch` of the running application.
 * @returns the platform and architecture keys, or undefined when the manifest has no section for them.
 */
export function communityPlatformKeys(os: string, arch: string): { readonly platform: string; readonly arch: string } | undefined {
  const platform = PLATFORM_KEYS[os]
  if (platform === undefined) return undefined
  if (arch !== 'x64' && arch !== 'arm64') return undefined
  return { platform, arch }
}

/** Read one property of an untrusted object without asserting anything about its type. */
function member(source: object, key: string): unknown {
  return (source as Record<string, unknown>)[key]
}

/** Whether a value is a non-null object, which is the only shape a nested manifest section may have. */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one asset entry.
 * @param value - the untrusted entry.
 * @param identity - the fork's release identity.
 * @returns the asset, or undefined when any field is outside its shape.
 */
function readAsset(value: unknown, identity: CommunityReleaseIdentity): CommunityUpdateAsset | undefined {
  if (!isObject(value)) return undefined
  const { fileName, url, sha256, size } = value as Record<string, unknown>
  if (typeof fileName !== 'string' || fileName === '' || fileName.includes('/') || fileName.includes('\\')) return undefined
  if (typeof url !== 'string' || communityReleaseOrigin(url, identity) !== 'installer-asset') return undefined
  if (typeof sha256 !== 'string' || !SAFE_SHA256.test(sha256)) return undefined
  if (size === undefined) return { fileName, url, sha256 }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return undefined
  return { fileName, url, sha256, size }
}

/**
 * Validate a manifest body against one release identity and one running platform.
 *
 * The platform is an argument rather than a lookup inside the document so a manifest can never be
 * asked for an installer the client cannot check: an architecture with no section is refused as
 * unsupported, and one whose section is malformed is refused as an invalid asset. Nothing here reads
 * the filesystem or the network, so a unit test can drive the whole matrix.
 * @param text - the manifest body as it arrived.
 * @param identity - the fork's release identity the URL must belong to.
 * @param platform - the running platform and architecture.
 * @returns the validated manifest, or the fault that refused it.
 */
export function parseCommunityUpdateManifest(
  text: string,
  identity: CommunityReleaseIdentity,
  platform: { readonly os: string; readonly arch: string },
): CommunityUpdateManifestResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'invalid', fault: 'malformed-json' }
  }
  if (!isObject(parsed)) return { kind: 'invalid', fault: 'malformed-json' }
  if (member(parsed, 'schemaVersion') !== COMMUNITY_UPDATE_SCHEMA_VERSION) {
    return { kind: 'invalid', fault: 'unsupported-schema' }
  }
  if (member(parsed, 'channel') !== COMMUNITY_UPDATE_STABLE_CHANNEL) {
    return { kind: 'invalid', fault: 'invalid-channel' }
  }
  const version = member(parsed, 'version')
  if (typeof version !== 'string') return { kind: 'invalid', fault: 'invalid-version' }
  const parsedVersion = parseCommunityVersion(version)
  if (parsedVersion === undefined || parsedVersion.prerelease.length > 0) {
    return { kind: 'invalid', fault: 'invalid-version' }
  }
  const publishedAt = member(parsed, 'publishedAt')
  if (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt))) {
    return { kind: 'invalid', fault: 'invalid-published-at' }
  }
  const upstreamBase = member(parsed, 'upstreamBase')
  if (upstreamBase !== undefined && (typeof upstreamBase !== 'string' || !SAFE_UPSTREAM_BASE.test(upstreamBase))) {
    return { kind: 'invalid', fault: 'invalid-upstream-base' }
  }
  const releaseNotesUrl = member(parsed, 'releaseNotesUrl')
  if (releaseNotesUrl !== undefined
    && (typeof releaseNotesUrl !== 'string' || communityReleaseOrigin(releaseNotesUrl, identity) === 'unknown')) {
    return { kind: 'invalid', fault: 'invalid-release-notes-url' }
  }
  const keys = communityPlatformKeys(platform.os, platform.arch)
  if (keys === undefined) return { kind: 'invalid', fault: 'unsupported-platform' }
  const section = member(parsed, keys.platform)
  if (!isObject(section)) return { kind: 'invalid', fault: 'unsupported-platform' }
  const asset = readAsset(member(section, keys.arch), identity)
  if (asset === undefined) return { kind: 'invalid', fault: 'invalid-asset' }
  return {
    kind: 'valid',
    manifest: {
      schemaVersion: COMMUNITY_UPDATE_SCHEMA_VERSION,
      version,
      channel: COMMUNITY_UPDATE_STABLE_CHANNEL,
      publishedAt,
      ...upstreamBase === undefined ? {} : { upstreamBase },
      ...releaseNotesUrl === undefined ? {} : { releaseNotesUrl },
      asset,
    },
  }
}
