/**
 * Build the Community update manifest for one installer.
 *
 * A release publishes two files: the installer, and a manifest naming it. The manifest is what a
 * running Community installation actually reads, and the only field a person could get wrong by hand
 * is the SHA-256 — which is also the field that decides whether a downloaded file is ever accepted.
 * So the digest is computed here, from the installer itself, rather than typed into a release note.
 *
 * Three properties shape the rest of the script.
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

/** Schema version the client reads; the number is a contract, not a default. */
const SCHEMA_VERSION = 1

/** Channel a published manifest declares. */
const CHANNEL = 'stable'

/** A Community release version: bare, dot-separated, and with no prerelease suffix. */
const STABLE_VERSION = /^\d{1,4}(?:\.\d{1,5}){0,2}$/u

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
type CommittedReader = (file: string) => Record<string, unknown>

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
 * Compute the SHA-256 of one file, streaming it.
 * @param path - absolute path of the installer.
 * @returns lowercase hexadecimal digest.
 */
async function sha256OfFile(path: string): Promise<string> {
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
 * @param options - the published asset name, target, publication time, and optional facts seam.
 * @returns the manifest, ready to be written.
 */
export async function buildCommunityReleaseManifest(
  installer: string,
  options: {
    readonly name: string
    readonly target: string
    readonly publishedAt: string
    readonly read?: CommittedReader
  },
): Promise<CommunityReleaseManifest> {
  const read = options.read ?? readCommitted
  const version = read(VERSION_FILE)
  const release = read(RELEASE_FILE)
  // A stable manifest must name a release. Publishing one for a development version would tell every
  // client that `0.2-dev` is the stable 0.2, which is the single most damaging thing this script
  // could do, so it stops here instead.
  if (typeof version.communityVersion !== 'string' || !STABLE_VERSION.test(version.communityVersion)) {
    throw new Error(`community release manifest: ${VERSION_FILE} must declare a release version; run the Community release freeze first`)
  }
  const upstreamBase = requireField(version, 'upstreamBase', UPSTREAM_BASE, VERSION_FILE)
  const repository = requireField(release, 'repository', REPOSITORY, RELEASE_FILE)
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
  const tag = `community-v${version.communityVersion}`
  const assetUrl = `https://github.com/${repository}/releases/download/${tag}/${options.name}`
  const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`
  const size = statSync(installer).size
  const sha256 = await sha256OfFile(installer)
  const assets = { [target.arch]: { fileName: options.name, url: assetUrl, sha256, size } }
  return {
    schemaVersion: SCHEMA_VERSION,
    version: version.communityVersion,
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
 * @param installer - absolute path of the installer to publish.
 * @param argv - command-line arguments, read for `--out`, `--name`, `--target`, and `--published-at`.
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
  const manifest = await buildCommunityReleaseManifest(installer, {
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
    console.error('  pnpm --filter @deepseek-ai/dsh-desktop run community:release:manifest -- <installer.exe> --published-at 2026-10-06T00:00:00Z')
    process.exitCode = 1
  } else {
    const run = await writeCommunityReleaseManifest(resolve(installer))
    console.log(`community release manifest: wrote ${run.fileName} for version ${run.manifest.version}`)
    console.log(`  ${run.path}`)
  }
}
