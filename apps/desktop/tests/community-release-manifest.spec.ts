/**
 * The release-side half of the update contract: the manifest the fork publishes.
 *
 * A published manifest and the client that reads it are two programs that must agree about three
 * things — the URL shape, the version naming, and the field names — and nothing in either program
 * would fail if they drifted apart. So the cases below assert the agreement directly: the addresses
 * this script composes are compared with the ones `src/community-release.ts` builds from the same
 * identity, and the document it writes is fed back through the client's own validator.
 *
 * The refusal cases are the other half. The most damaging thing this script could do is publish a
 * stable manifest for a development version — every client would then be told `0.2-dev` is the stable
 * `0.2` — and the second most damaging is to emit bytes that differ between two runs of the same
 * release. Both are pinned here, and both are refused rather than warned about.
 *
 * The committed facts are read through an injected seam so a case can exercise a release version
 * without rewriting the repository's own files, and one case uses the real seam to pin the invariant
 * that a development version is never published.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCommunityReleaseManifest,
  writeCommunityReleaseManifest,
} from '../scripts/community-release-manifest.ts'
import { parseCommunityUpdateManifest } from '../src/community-update-manifest.ts'
import {
  communityAssetUrl,
  communityManifestUrl,
  communityReleaseLocation,
  communityReleaseOrigin,
  parseCommunityRelease,
  type CommunityReleaseIdentity,
} from '../src/community-release.ts'

/** The installer name the release workflow publishes. */
const ASSET_NAME = 'DeepSeek-Harness-Community-v0.2-Windows-x64.exe'

/** Installer bytes, and the digest a manifest must carry for them. */
const BYTES = Buffer.from('a packaged Community installer')
const DIGEST = createHash('sha256').update(BYTES).digest('hex')

/** The identity the release workflow publishes from, as the committed file declares it. */
const IDENTITY: CommunityReleaseIdentity = parseCommunityRelease(JSON.parse(
  readFileSync(fileURLToPath(new URL('../community-release.json', import.meta.url)), 'utf8'),
))!

/** The committed facts a frozen release would carry. */
const FROZEN: Record<string, Record<string, unknown>> = {
  'community-version.json': { communityVersion: '0.2', upstreamBase: 'dsh-v0.2.0-rc.2' },
  'community-release.json': { repository: IDENTITY.repository, manifest: IDENTITY.manifest },
}

/** Read one of the two committed facts files from a frozen declaration. */
function frozen(files: Record<string, Record<string, unknown>>): (file: string) => Record<string, unknown> {
  return (file: string) => {
    const value = files[file]
    if (value === undefined) throw new Error(`unexpected read of ${file}`)
    return value
  }
}

/** The publication time a case pins, so nothing reads a clock. */
const PUBLISHED_AT = '2026-10-06T00:00:00.000Z'

let root: string
let installer: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-community-release-'))
  installer = join(root, ASSET_NAME)
  writeFileSync(installer, BYTES)
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** Build one manifest from frozen facts. */
async function build(overrides: {
  readonly name?: string
  readonly target?: string
  readonly publishedAt?: string
  readonly files?: Record<string, Record<string, unknown>>
} = {}) {
  return await buildCommunityReleaseManifest(installer, {
    name: overrides.name ?? ASSET_NAME,
    target: overrides.target ?? 'win-x64',
    publishedAt: overrides.publishedAt ?? PUBLISHED_AT,
    read: frozen(overrides.files ?? FROZEN),
  })
}

describe('the manifest a release publishes', () => {
  it('names the release, its upstream base, and the installer the release workflow uploaded', async () => {
    const manifest = await build()
    expect(manifest).toEqual({
      schemaVersion: 1,
      version: '0.2',
      channel: 'stable',
      publishedAt: PUBLISHED_AT,
      upstreamBase: 'dsh-v0.2.0-rc.2',
      releaseNotesUrl: `https://github.com/${IDENTITY.repository}/releases/tag/community-v0.2`,
      windows: {
        x64: { fileName: ASSET_NAME, url: `https://github.com/${IDENTITY.repository}/releases/download/community-v0.2/${ASSET_NAME}`, sha256: DIGEST, size: BYTES.byteLength },
      },
    })
  })

  it('computes the digest and the size from the installer rather than taking them on trust', async () => {
    const manifest = await build()
    expect(manifest.windows.x64.sha256).toBe(DIGEST)
    expect(manifest.windows.x64.size).toBe(BYTES.byteLength)
    // A different file is a different digest, and the size follows the file rather than the name.
    writeFileSync(installer, 'different bytes')
    const other = await build()
    expect(other.windows.x64.sha256).not.toBe(DIGEST)
    expect(other.windows.x64.size).toBe('different bytes'.length)
  })

  it('composes exactly the addresses the client derives from the same repository', async () => {
    const manifest = await build()
    // The script spells its URL shapes itself, because a build script cannot import the bundled
    // application source. This is what keeps the two spellings from drifting apart.
    expect(manifest.windows.x64.url).toBe(communityAssetUrl(IDENTITY, 'community-v0.2', ASSET_NAME))
    expect(manifest.releaseNotesUrl).toBe(communityReleaseLocation(IDENTITY, '0.2', ASSET_NAME)!.releaseUrl)
    // And the client classifies the published asset address as its own release asset, which is the
    // condition it must pass before any download may start.
    expect(communityReleaseOrigin(manifest.windows.x64.url, IDENTITY)).toBe('asset')
    expect(communityManifestUrl(IDENTITY)).toContain(IDENTITY.manifest)
  })

  it('publishes a document the client\'s own validator accepts', async () => {
    const manifest = await build()
    const validated = parseCommunityUpdateManifest(JSON.stringify(manifest), IDENTITY, { os: 'win32', arch: 'x64' })
    expect(validated).toMatchObject({
      kind: 'valid',
      manifest: {
        version: '0.2',
        channel: 'stable',
        publishedAt: PUBLISHED_AT,
        upstreamBase: 'dsh-v0.2.0-rc.2',
        asset: { fileName: ASSET_NAME, sha256: DIGEST, size: BYTES.byteLength },
      },
    })
  })

  it('carries nothing about the machine that produced it', async () => {
    const manifest = await build()
    const text = JSON.stringify(manifest)
    expect(text).not.toContain(root)
    expect(text).not.toContain(tmpdir())
    expect(text).not.toContain('\\')
    expect(text).not.toContain(process.env.USERNAME ?? '\u0000')
    // The only absolute-looking values are the two published URLs, and both name the repository.
    for (const url of [manifest.windows.x64.url, manifest.releaseNotesUrl]) {
      expect(url.startsWith(`https://github.com/${IDENTITY.repository}/`)).toBe(true)
    }
  })

  it('is byte-for-byte the same for the same inputs, so a manifest can be regenerated', async () => {
    const first = JSON.stringify(await build())
    const second = JSON.stringify(await build())
    expect(second).toBe(first)
    // A different publication time is the one input that changes the bytes, which is why it is an
    // argument rather than a clock reading.
    expect(JSON.stringify(await build({ publishedAt: '2026-10-07T00:00:00.000Z' }))).not.toBe(first)
  })
})

describe('what the generator refuses to publish', () => {
  it('refuses a development version, and names the freeze that has to happen first', async () => {
    for (const communityVersion of ['0.2-dev', '0.2-rc.1', 'v0.2', 'latest', '', 2]) {
      await expect(build({ files: { ...FROZEN, 'community-version.json': { communityVersion, upstreamBase: 'dsh-v0.2.0-rc.2' } } }))
        .rejects.toThrow(/release version/u)
    }
  })

  it('refuses to guess the publication time, because a clock reading is not deterministic', async () => {
    await expect(writeCommunityReleaseManifest(installer, [], {}, frozen(FROZEN)))
      .rejects.toThrow(/--published-at/u)
    await expect(writeCommunityReleaseManifest(installer, ['--published-at', 'not a date'], {}, frozen(FROZEN)))
      .rejects.toThrow(/not a date/u)
    // `SOURCE_DATE_EPOCH` is accepted, because it is the convention build tooling pins one with.
    const run = await writeCommunityReleaseManifest(installer, [], { SOURCE_DATE_EPOCH: '1791072000' }, frozen(FROZEN))
    expect(run.manifest.publishedAt).toBe(new Date(1791072000 * 1000).toISOString())
  })

  it('refuses a facts file whose fields are outside their shape', async () => {
    const cases: readonly Record<string, Record<string, unknown>>[] = [
      { ...FROZEN, 'community-version.json': { communityVersion: '0.2' } },
      { ...FROZEN, 'community-version.json': { communityVersion: '0.2', upstreamBase: 'v0.2' } },
      { ...FROZEN, 'community-version.json': { communityVersion: '0.2', upstreamBase: 'dsh-v0.2.0/../../x' } },
      { ...FROZEN, 'community-release.json': { manifest: IDENTITY.manifest } },
      { ...FROZEN, 'community-release.json': { repository: '../deepseek-ai/deepseek-harness', manifest: IDENTITY.manifest } },
      { ...FROZEN, 'community-release.json': { repository: IDENTITY.repository } },
      { ...FROZEN, 'community-release.json': { repository: IDENTITY.repository, manifest: 'notes.txt' } },
    ]
    for (const files of cases) await expect(build({ files })).rejects.toThrow(/declares an unusable|must declare/u)
  })

  it('refuses an asset name or a target the release workflow would not publish', async () => {
    for (const name of ['setup', 'setup.msi', 'a/b.exe', '../setup.exe', '']) {
      await expect(build({ name })).rejects.toThrow(/plain \.exe file name/u)
    }
    for (const target of ['win-arm64', 'macos-arm64', 'linux-x64', '']) {
      await expect(build({ target })).rejects.toThrow(/not a published target/u)
    }
  })

  it('never lets a development version become a published manifest, whatever the committed facts are', async () => {
    // The real seam, so this is a statement about the repository as it stands rather than about the
    // fixture: either the fork is frozen and the manifest names a release, or nothing is published.
    try {
      const manifest = await buildCommunityReleaseManifest(installer, { name: ASSET_NAME, target: 'win-x64', publishedAt: PUBLISHED_AT })
      expect(manifest.version).not.toContain('-')
      expect(manifest.channel).toBe('stable')
    } catch (error) {
      expect(String(error)).toMatch(/release version/u)
    }
  })
})

describe('where the generator writes', () => {
  it('writes the file name the release identity declares, beside the installer by default', async () => {
    const run = await writeCommunityReleaseManifest(installer, ['--published-at', PUBLISHED_AT], {}, frozen(FROZEN))
    expect(run.fileName).toBe(IDENTITY.manifest)
    expect(run.path).toBe(join(root, IDENTITY.manifest))
    expect(JSON.parse(readFileSync(run.path, 'utf8'))).toEqual(run.manifest)
  })

  it('writes the same bytes however the arguments are spelled, and honours --out', async () => {
    const first = await writeCommunityReleaseManifest(installer, ['--published-at', PUBLISHED_AT], {}, frozen(FROZEN))
    const inline = await writeCommunityReleaseManifest(installer, [`--published-at=${PUBLISHED_AT}`, `--name=${ASSET_NAME}`, '--target=win-x64'], {}, frozen(FROZEN))
    expect(inline.manifest).toEqual(first.manifest)
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    const run = await writeCommunityReleaseManifest(installer, ['--published-at', PUBLISHED_AT, '--out', elsewhere], {}, frozen(FROZEN))
    expect(run.path).toBe(join(elsewhere, IDENTITY.manifest))
    expect(readFileSync(run.path, 'utf8')).toBe(readFileSync(first.path, 'utf8'))
    // The file ends in one newline, so a regenerated manifest is a no-op diff.
    expect(readFileSync(run.path, 'utf8').endsWith('}\n')).toBe(true)
  })
})
