/**
 * Stage one Community release: the exact files an upload will publish, built from the installer this
 * run produced.
 *
 * A release publishes three files and the order they are produced in is the whole point of this
 * script. The installer is renamed first, because the name decides the URL that ends up inside the
 * manifest; the digest is taken from the renamed file, because the digest is a statement about the
 * bytes that will be downloaded; and only then is the manifest written, so the file it names, the
 * digest it carries, and the URL it points at all describe the same object. Hashing the internal
 * build name and renaming afterwards would work today — a rename changes no bytes — but it would put
 * the pipeline one content-changing step away from publishing a checksum for a file nobody receives.
 *
 * The digest is then confirmed against the staged file rather than trusted from the builder, which is
 * what makes the confirmation a check instead of a restatement: it re-reads what is on disk, so a
 * staging step that rewrote or moved the installer fails here, before anything is uploaded.
 *
 * `SHA256SUMS.txt` is written for a person who would rather verify a download by hand. It is not a
 * client input: a running installation trusts the digest inside the manifest, which it fetched over
 * HTTPS from the same release, and never parses this file. The two are always computed from the same
 * staged bytes, so they cannot disagree.
 *
 * Nothing here touches the network or a GitHub API, so the whole step runs from a fixture installer
 * in a directory that is deleted afterwards — which is how the dry run in
 * `apps/desktop/tests/community-release-staging.spec.ts` exercises it.
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  communityInstallerAssetName,
  readCommunityReleaseVersion,
  resolveCommunityReleaseTag,
  sha256OfFile,
  writeCommunityReleaseManifest,
  type CommittedReader,
} from './community-release-manifest.ts'

/** Name of the human-readable checksum list a release carries. */
export const COMMUNITY_CHECKSUM_FILE = 'SHA256SUMS.txt'

/** Where one staged release lives, and what is in it. */
export interface CommunityReleaseStage {
  /** Absolute path of the staging directory. */
  readonly directory: string
  /** The installer, under the name the release publishes it as. */
  readonly installer: string
  /** The update manifest a client fetches. */
  readonly manifest: string
  /** The checksum list, for a person verifying a download by hand. */
  readonly checksums: string
  /** Published asset name of the installer. */
  readonly asset: string
  /** SHA-256 of the staged installer, as the manifest declares it. */
  readonly sha256: string
  /** Byte size of the staged installer. */
  readonly size: number
}

/**
 * Confirm one staged installer is the file a digest describes.
 *
 * The file is re-read rather than remembered, so this answers "is this still the file whose digest we
 * published" and not "did we compute a digest a moment ago". Called with the digest a manifest
 * declares, it is the release's own confirmation that the checksum and the bytes agree.
 * @param options - the staged installer and the digest it has to hash to.
 * @returns nothing; a file that hashes to something else is refused.
 */
export async function confirmStagedInstaller(options: {
  readonly installer: string
  readonly sha256: string
}): Promise<void> {
  const actual = await sha256OfFile(options.installer)
  if (actual !== options.sha256) {
    throw new Error(`community release staging: ${basename(options.installer)} hashes to ${actual}, not to the published ${options.sha256}`)
  }
}

/**
 * Stage the files one Community release publishes.
 * @param options - the built installer, the staging directory, the release tag, and the publication time.
 * @returns the staged files, their published names, and the digest they carry.
 */
export async function stageCommunityRelease(options: {
  readonly installer: string
  readonly out: string
  readonly tag: string
  readonly publishedAt: string
  readonly read?: CommittedReader
}): Promise<CommunityReleaseStage> {
  // Both published-name rules are settled before anything is written. A release that turns out not to
  // be publishable therefore leaves no staged directory for a later step to pick up and upload, and
  // the two checks are the same ones the manifest itself enforces, applied while the reason a run is
  // refused is still the only thing that has happened.
  const version = readCommunityReleaseVersion(options.read)
  const tag = resolveCommunityReleaseTag(version, options.tag)
  const asset = communityInstallerAssetName(version)
  const directory = resolve(options.out)
  mkdirSync(directory, { recursive: true })
  const installer = join(directory, asset)
  copyFileSync(options.installer, installer)
  const run = await writeCommunityReleaseManifest(
    installer,
    ['--tag', tag, '--name', asset, '--out', directory, '--published-at', options.publishedAt],
    {},
    options.read,
  )
  const { sha256, size } = run.manifest.windows.x64
  await confirmStagedInstaller({ installer, sha256 })
  const checksums = join(directory, COMMUNITY_CHECKSUM_FILE)
  // The two-space separator is what `sha256sum -c` reads, so the workflow's own confirmation can use
  // the released file directly instead of restating its format here.
  writeFileSync(checksums, `${sha256}  ${asset}\n`, 'utf8')
  return { directory, installer, manifest: run.path, checksums, asset, sha256, size }
}

/**
 * Require one command-line option.
 * @param value - the parsed value, absent when the option was not given.
 * @param name - option name without its leading dashes.
 * @returns the value.
 */
function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new Error(`community release staging: --${name} is required`)
  }
  return value
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: {
        out: { type: 'string' },
        tag: { type: 'string' },
        'published-at': { type: 'string' },
      },
      allowPositionals: true,
    })
    const installer = positionals[0]
    if (installer === undefined) {
      throw new Error('community release staging: pass the built installer, for example')
    }
    const stage = await stageCommunityRelease({
      installer: resolve(installer),
      out: required(values.out, 'out'),
      tag: required(values.tag, 'tag'),
      publishedAt: required(values['published-at'], 'published-at'),
    })
    console.log(`community release staging: ${stage.asset} (${stage.size} bytes)`)
    console.log(`  sha256 ${stage.sha256}`)
    for (const file of [stage.installer, stage.manifest, stage.checksums]) console.log(`  ${file}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    if (process.argv.slice(2).length === 0) {
      console.error('  pnpm --filter @deepseek-ai/dsh-desktop run community:release:stage <installer.exe> --out <dir> --tag community-v0.2 --published-at 2026-10-06T00:00:00Z')
    }
    process.exitCode = 1
  }
}
