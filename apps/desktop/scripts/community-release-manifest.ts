/**
 * Build the Community update manifest for one installer.
 *
 * A release publishes two files: the installer, and a manifest naming it. The manifest is what a
 * running Community installation actually reads, and the only field a person could get wrong by hand
 * is the SHA-256 — which is also the field that decides whether a downloaded file is ever accepted.
 * So the digest is computed here, from the installer itself, rather than typed into a release note.
 *
 * Five properties shape the rest of the script.
 *
 * - **The output is deterministic.** The same installer, version, and publication time produce the
 *   same bytes, so a manifest can be regenerated and compared. The publication time is therefore an
 *   input rather than a clock reading: pass `--published-at`, or set `SOURCE_DATE_EPOCH`, and the
 *   script refuses to guess.
 * - **The output carries nothing local.** Only the published file name, the size, the digest, and
 *   URLs derived from the declared repository reach the file — no absolute path, no environment
 *   value, and no credential.
 * - **It refuses a development version.** A stable manifest names a release, so a fork still on
 *   `0.2-dev` is told to freeze its version first instead of publishing a manifest that says
 *   `stable` about a development build.
 * - **It publishes only to the fork's own repository.** The committed identity is the URL source, so
 *   a copied or edited file would otherwise be able to aim every installation at somebody else's
 *   releases. The value is therefore compared against the pinned repository before any URL is built.
 * - **The release tag is an input, not a derivation.** `--tag` must name exactly the version the
 *   committed facts declare, so a run cannot publish a manifest into a release whose name claims a
 *   different version. Deriving the tag from the version would make the two agree by construction
 *   and the check vacuous; requiring the operator to state it makes them agree because they were
 *   compared.
 *
 * The URL shapes below are spelled here as well as in `src/community-release.ts`, for the reason
 * `community-upstream-commit.mjs` spells its field name twice: a build script cannot import the
 * bundled application source. `apps/desktop/tests/community-release-manifest.spec.ts` asserts the
 * two agree on the same identity.
 */

import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository-relative location of the committed version facts. */
const VERSION_FILE = 'community-version.json'

/** Repository-relative location of the committed release identity. */
const RELEASE_FILE = 'community-release.json'

/**
 * The repository this fork publishes Community releases from.
 *
 * The committed file is where the URL value comes from, because the packaged application reads the
 * same file and neither side may hold a second copy of it. This constant is the other half of that
 * arrangement: it is what the committed value is *checked against*, so a file copied from another
 * fork, or edited by hand, stops the release instead of aiming every installation somewhere nobody
 * reviewed. Renaming the fork is therefore a deliberate edit here, not a silent consequence of a
 * configuration change.
 */
export const COMMUNITY_RELEASE_REPOSITORY = 'newplayer0408-jpg/deepseek-harness'

/** Prefix every Community release tag carries, so one is never read as an upstream `dsh-v*` tag. */
export const COMMUNITY_RELEASE_TAG_PREFIX = 'community-v'

/** Schema version the client reads; the number is a contract, not a default. */
const SCHEMA_VERSION = 1

/** Channel a published manifest declares. */
const CHANNEL = 'stable'

/** A Community release version: bare, dot-separated, and with no prerelease suffix. */
const STABLE_VERSION = /^\d{1,4}(?:\.\d{1,5}){0,2}$/u

/** A published Community release tag. A stable manifest is published by a stable release. */
const RELEASE_TAG = /^community-v\d{1,4}(?:\.\d{1,5}){0,2}$/u

/** An upstream release tag, as upstream names one. */
const UPSTREAM_BASE = /^dsh-v\d{1,4}(?:\.\d{1,5}){0,2}(?:-[A-Za-z0-9.]{1,32})?$/u

/** A GitHub `owner/name` repository pair. */
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u

/** A published installer asset name. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.exe$/u

/** A manifest file name, as the release identity declares one. */
const MANIFEST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/u

/**
 * The targets this script can publish, keyed by the name `--target` takes.
 *
 * The section and architecture are literal types rather than plain strings, so the manifest below is
 * built with the keys the schema declares instead of a computed key that could be anything. That is
 * what lets the returned object be the manifest type itself, with no assertion standing in for a
 * shape nobody checked.
 */
const TARGETS = {
  'win-x64': { section: 'windows', arch: 'x64' },
} as const satisfies Readonly<Record<string, { readonly section: string; readonly arch: string }>>

/** One target this script publishes: the section it fills and the architecture within it. */
type CommunityReleaseTarget = (typeof TARGETS)[keyof typeof TARGETS]

/**
 * Resolve a target name to the section and architecture it publishes.
 * @param name - the `--target` value.
 * @returns the target, or undefined when nothing is published under that name.
 */
function resolveTarget(name: string): CommunityReleaseTarget | undefined {
  return Object.entries(TARGETS).find(([published]) => published === name)?.[1]
}

/** The manifest this script writes. */
interface CommunityReleaseManifest {
  readonly schemaVersion: number
  readonly version: string
  readonly channel: string
  readonly publishedAt: string
  readonly upstreamBase: string
  readonly releaseNotesUrl: string
  readonly windows: {
    readonly x64: {
      readonly fileName: string
      readonly url: string
      readonly sha256: string
      readonly size: number
    }
  }
}

/** Read one committed JSON file beside the desktop package. */
function readCommitted(file: string): Record<string, unknown> {
  const path = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', file)
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`community release manifest: ${file} is not an object`)
  return parsed as Record<string, unknown>
}

/**
 * Read one committed file, through the seam a caller may replace.
 *
 * The seam exists so the generator is testable without rewriting the repository's own committed
 * facts: a spec supplies the two files as objects and asserts the URLs this script composes are the
 * ones `src/community-release.ts` builds from the same identity, which is the property that keeps a
 * published manifest and the client looking for it from drifting apart.
 */
export type CommittedReader = (file: string) => Record<string, unknown>

/**
 * Read one required string field, gated against the shape its source produces.
 * @param source - the parsed file.
 * @param key - field name.
 * @param pattern - shape the field must have.
 * @param origin - file the field came from, for the failure message.
 * @returns the field value.
 */
function requireField(source: Record<string, unknown>, key: string, pattern: RegExp, origin: string): string {
  const value = source[key]
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`community release manifest: ${origin} declares an unusable ${key}`)
  }
  return value
}

/**
 * Read the release version out of the committed version facts.
 *
 * A development version has no published form at all, so this refuses it where the reason is still
 * visible. Every published name — the release tag, the installer asset, the manifest a client
 * fetches — is derived from this value, so it is the one field that has to be settled first.
 * @param declared - the parsed version file.
 * @returns the version without a leading `v`, such as `0.2`.
 */
function requireStableVersion(declared: Record<string, unknown>): string {
  const version = declared.communityVersion
  if (typeof version !== 'string' || !STABLE_VERSION.test(version)) {
    throw new Error(`community release manifest: ${VERSION_FILE} must declare a release version; run the Community release freeze first`)
  }
  return version
}

/**
 * Read the Community version a release may publish, from the committed facts.
 * @param read - committed-facts reader, replaceable so a spec can freeze a release version.
 * @returns the version without a leading `v`, such as `0.2`.
 */
export function readCommunityReleaseVersion(read: CommittedReader = readCommitted): string {
  return requireStableVersion(read(VERSION_FILE))
}

/**
 * Name the installer asset one Community release publishes.
 *
 * The packaged installer is named after the version it *packages*, which is upstream's, so its build
 * name says nothing about the Community version it ships as. A published release therefore carries
 * the fork's own name, derived here rather than typed into a workflow, so the manifest, the uploaded
 * asset, and the release notes cannot name three different files.
 * @param version - Community version without its leading `v`, already gated as a release version.
 * @returns the Windows x64 installer asset name.
 */
export function communityInstallerAssetName(version: string): string {
  return `DeepSeek-Harness-Community-v${version}-Windows-x64.exe`
}

/**
 * Check the release tag a run intends to publish under.
 *
 * Two things are checked, and the second is the one that matters: the tag has to be a Community
 * release tag at all, and it has to name exactly the version the committed facts declare. A tag that
 * is well-formed but names a different version would publish a client-visible manifest whose asset
 * URL points into a release that does not describe it, so it stops the run.
 * @param version - Community version without its leading `v`.
 * @param requested - the `--tag` value.
 * @returns the tag, for building the URLs from.
 */
export function resolveCommunityReleaseTag(version: string, requested: string): string {
  if (!RELEASE_TAG.test(requested)) {
    throw new Error(`community release manifest: ${JSON.stringify(requested)} is not a Community release tag; it must be ${COMMUNITY_RELEASE_TAG_PREFIX}<version> with no prerelease suffix`)
  }
  const expected = `${COMMUNITY_RELEASE_TAG_PREFIX}${version}`
  if (requested !== expected) {
    throw new Error(`community release manifest: release tag ${requested} does not name the version ${VERSION_FILE} declares (${expected}); freeze the version or publish under the matching tag`)
  }
  return requested
}

/**
 * Compute the SHA-256 of one file, streaming it.
 *
 * Exported because the staging step has to recompute a digest over the file it actually uploads and
 * compare it against the manifest: two implementations of "the digest of this file" would be two
 * chances for the published checksum and the published bytes to disagree.
 * @param path - absolute path of the installer.
 * @returns lowercase hexadecimal digest.
 */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** One command-line value, as `--name value` or `--name=value`. */
function option(argv: readonly string[], name: string): string | undefined {
  const joined = `${name}=`
  const inline = argv.find(argument => argument.startsWith(joined))
  if (inline !== undefined) return inline.slice(joined.length)
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

/**
 * Resolve the publication time the manifest declares.
 *
 * A clock reading would make two runs disagree, so the time is an input. `SOURCE_DATE_EPOCH` is
 * accepted because it is the convention build tooling already uses to pin one.
 * @param argv - command-line arguments.
 * @param env - process environment.
 * @returns the publication time, as an ISO string.
 */
function resolvePublishedAt(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  const explicit = option(argv, '--published-at')
  const epoch = explicit ?? env.SOURCE_DATE_EPOCH
  if (epoch === undefined) {
    throw new Error('community release manifest: pass --published-at <iso> (or set SOURCE_DATE_EPOCH) so the output is deterministic')
  }
  const milliseconds = /^\d+$/u.test(epoch) ? Number(epoch) * 1000 : Date.parse(epoch)
  if (!Number.isFinite(milliseconds)) throw new Error('community release manifest: --published-at is not a date')
  return new Date(milliseconds).toISOString()
}

/**
 * Build the manifest for one installer.
 *
 * @param installer - absolute path of the installer to publish.
 * @param options - the release tag, the published asset name, target, publication time, and optional facts seam.
 * @returns the manifest, ready to be written.
 */
export async function buildCommunityReleaseManifest(
  installer: string,
  options: {
    readonly tag: string
    readonly name: string
    readonly target: string
    readonly publishedAt: string
    readonly read?: CommittedReader
  },
): Promise<CommunityReleaseManifest> {
  const read = options.read ?? readCommitted
  const facts = read(VERSION_FILE)
  const release = read(RELEASE_FILE)
  // A stable manifest must name a release. Publishing one for a development version would tell every
  // client that `0.2-dev` is the stable 0.2, which is the single most damaging thing this script
  // could do, so it stops here instead.
  const version = requireStableVersion(facts)
  const upstreamBase = requireField(facts, 'upstreamBase', UPSTREAM_BASE, VERSION_FILE)
  const repository = requireField(release, 'repository', REPOSITORY, RELEASE_FILE)
  if (repository !== COMMUNITY_RELEASE_REPOSITORY) {
    throw new Error(`community release manifest: ${RELEASE_FILE} names ${repository}, which is not the repository this fork publishes from (${COMMUNITY_RELEASE_REPOSITORY})`)
  }
  // The manifest's own file name is the contract a client fetches, so it is validated here as well as
  // at the write: a build that would publish under a name no client looks for stops before it reads
  // the installer, rather than after.
  requireField(release, 'manifest', MANIFEST_NAME, RELEASE_FILE)
  const target = resolveTarget(options.target)
  if (target === undefined) {
    throw new Error(`community release manifest: ${options.target} is not a published target`)
  }
  if (!ASSET_NAME.test(options.name)) {
    throw new Error('community release manifest: the published asset name must be a plain .exe file name')
  }
  const asset = communityInstallerAssetName(version)
  if (options.name !== asset) {
    throw new Error(`community release manifest: version ${version} publishes ${asset}, not ${options.name}; stage the installer under its published name before generating the manifest`)
  }
  const tag = resolveCommunityReleaseTag(version, options.tag)
  const assetUrl = `https://github.com/${repository}/releases/download/${tag}/${asset}`
  const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`
  const size = statSync(installer).size
  const sha256 = await sha256OfFile(installer)
  const assets = { [target.arch]: { fileName: asset, url: assetUrl, sha256, size } }
  return {
    schemaVersion: SCHEMA_VERSION,
    version,
    channel: CHANNEL,
    publishedAt: options.publishedAt,
    upstreamBase,
    releaseNotesUrl: releaseUrl,
    [target.section]: assets,
  }
}

/** Where one run writes, and what it wrote. */
export interface CommunityReleaseManifestRun {
  /** Absolute path of the manifest file. */
  readonly path: string
  /** The manifest, as written. */
  readonly manifest: CommunityReleaseManifest
  /** File name the manifest was written under. */
  readonly fileName: string
}

/**
 * Write the manifest for one installer.
 *
 * The installer has to be the file that will actually be uploaded, under the name it will be
 * uploaded as: the digest is computed from what is on disk, and the asset name is checked against the
 * name this version publishes, so a manifest can never describe a file the release does not carry.
 * @param installer - absolute path of the installer to publish.
 * @param argv - command-line arguments, read for `--tag`, `--out`, `--name`, `--target`, and `--published-at`.
 * @param env - process environment, read for `SOURCE_DATE_EPOCH`.
 * @param read - optional seam for the two committed facts files.
 * @returns the manifest and where it was written.
 */
export async function writeCommunityReleaseManifest(
  installer: string,
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  read: CommittedReader = readCommitted,
): Promise<CommunityReleaseManifestRun> {
  const release = read(RELEASE_FILE)
  const manifestName = requireField(release, 'manifest', MANIFEST_NAME, RELEASE_FILE)
  const tag = option(argv, '--tag')
  if (tag === undefined) {
    throw new Error('community release manifest: pass --tag community-v<version>, so the manifest names the release it is published in')
  }
  const manifest = await buildCommunityReleaseManifest(installer, {
    tag,
    name: option(argv, '--name') ?? basename(installer),
    target: option(argv, '--target') ?? 'win-x64',
    publishedAt: resolvePublishedAt(argv, env),
    read,
  })
  const directory = option(argv, '--out') ?? dirname(installer)
  const path = join(resolve(directory), manifestName)
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { path, manifest, fileName: manifestName }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const installer = process.argv.slice(2).find(argument => !argument.startsWith('--'))
  if (installer === undefined) {
    console.error('community release manifest: pass the installer to publish, for example')
    console.error('  pnpm --filter @deepseek-ai/dsh-desktop run community:release:manifest <installer.exe> --tag community-v0.2 --published-at 2026-10-06T00:00:00Z')
    process.exitCode = 1
  } else {
    const run = await writeCommunityReleaseManifest(resolve(installer))
    console.log(`community release manifest: wrote ${run.fileName} for version ${run.manifest.version}`)
    console.log(`  ${run.path}`)
  }
}
