/**
 * The staging half of the release: the three files a release uploads, produced from one installer.
 *
 * The dry run is the point of these cases. A release step can only be exercised against GitHub, which
 * nothing here does; what can be exercised is everything up to the upload — the published names, the
 * manifest the client will read, the digest that has to describe the bytes on disk, and the checksum
 * list the workflow confirms with. So each case builds a fixture installer in a directory of its own,
 * stages a release from it, and reads the result back the way the workflow and the client would. The
 * directory is deleted afterwards, because staged output is build output and never a repository file.
 *
 * Two of the cases are about the order the files are produced in, which is the property that is
 * invisible in a reading of the code and expensive to discover in a release: the installer is renamed
 * before it is hashed, and the digest is confirmed against the staged file rather than trusted from
 * the step that computed it. The second is only a check if it can fail, so a case overwrites a staged
 * installer and requires the confirmation to refuse it.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMMUNITY_CHECKSUM_FILE, confirmStagedInstaller, stageCommunityRelease } from '../scripts/stage-community-release.ts'
import { parseCommunityUpdateManifest } from '../src/community-update-manifest.ts'
import {
  communityAssetUrl,
  communityManifestUrl,
  communityReleaseLocation,
  parseCommunityRelease,
  type CommunityReleaseIdentity,
} from '../src/community-release.ts'

/** The identity the release workflow publishes from, as the committed file declares it. */
const IDENTITY: CommunityReleaseIdentity = parseCommunityRelease(JSON.parse(
  readFileSync(fileURLToPath(new URL('../community-release.json', import.meta.url)), 'utf8'),
))!

/** The installer name the release publishes, and the tag the frozen facts publish it under. */
const ASSET_NAME = 'DeepSeek-Harness-Community-v0.2-Windows-x64.exe'
const TAG = 'community-v0.2'

/** The name the build produces, which is upstream's version and not a published name at all. */
const BUILT_NAME = 'deepseek-harness-0.1.7-rc.1-win-x64-community-unsigned.exe'

/** Installer bytes, and the digest a manifest must carry for them. */
const BYTES = Buffer.from('a packaged Community installer')
const DIGEST = createHash('sha256').update(BYTES).digest('hex')

/** The publication time a case pins, so nothing reads a clock. */
const PUBLISHED_AT = '2026-10-06T00:00:00.000Z'

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

let root: string
let built: string
let out: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-community-stage-'))
  built = join(root, BUILT_NAME)
  out = join(root, 'release-stage')
  writeFileSync(built, BYTES)
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** Stage one release from the fixture installer. */
async function stage(overrides: {
  readonly tag?: string
  readonly files?: Record<string, Record<string, unknown>>
} = {}) {
  return await stageCommunityRelease({
    installer: built,
    out,
    tag: overrides.tag ?? TAG,
    publishedAt: PUBLISHED_AT,
    read: frozen(overrides.files ?? FROZEN),
  })
}

describe('the dry-run release stage', () => {
  it('holds exactly the three files a release publishes, under their published names', async () => {
    const result = await stage()
    expect(readdirSync(out).sort()).toEqual([ASSET_NAME, COMMUNITY_CHECKSUM_FILE, IDENTITY.manifest].sort())
    expect(result.asset).toBe(ASSET_NAME)
    expect(result.sha256).toBe(DIGEST)
    expect(result.size).toBe(BYTES.byteLength)
    expect(result.directory).toBe(out)
  })

  it('renames the built installer before hashing it, so the digest describes the published file', async () => {
    const result = await stage()
    // The build name is upstream's version and carries no published meaning; nothing staged keeps it.
    expect(result.installer).toBe(join(out, ASSET_NAME))
    expect(readFileSync(result.installer).equals(BYTES)).toBe(true)
    expect(readFileSync(result.installer).equals(readFileSync(built))).toBe(true)
    expect(readdirSync(out).some(name => name.includes('0.1.7-rc.1'))).toBe(false)
  })

  it('stages a manifest the client accepts, naming the immutable release rather than the alias', async () => {
    const result = await stage()
    const text = readFileSync(result.manifest, 'utf8')
    const validated = parseCommunityUpdateManifest(text, IDENTITY, { os: 'win32', arch: 'x64' })
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
    // A client discovers the manifest through the stable alias, which is a property of the client and
    // not of the file; what the file carries is the version tag, for both the installer and the notes,
    // so a later release cannot change what this manifest points at.
    expect(communityManifestUrl(IDENTITY))
      .toBe(`https://github.com/${IDENTITY.repository}/releases/latest/download/${IDENTITY.manifest}`)
    const manifest = JSON.parse(text) as { readonly releaseNotesUrl: string; readonly windows: { readonly x64: { readonly url: string } } }
    expect(manifest.windows.x64.url).toBe(communityAssetUrl(IDENTITY, TAG, ASSET_NAME))
    expect(manifest.releaseNotesUrl).toBe(communityReleaseLocation(IDENTITY, '0.2', ASSET_NAME)!.releaseUrl)
    expect(text).not.toContain('latest/download')
  })

  it('writes a checksum list the release lane can confirm with, naming the staged installer', async () => {
    const result = await stage()
    const lines = readFileSync(result.checksums, 'utf8').split('\n').filter(line => line !== '')
    // One entry, digest first, then the two spaces `sha256sum -c` splits the file name on.
    expect(lines).toEqual([`${DIGEST}  ${ASSET_NAME}`])
    const [digest, name] = lines[0]!.split('  ')
    expect(digest).toBe(DIGEST)
    expect(name).toBe(ASSET_NAME)
    // The list and the manifest are computed from the same staged bytes, so they cannot disagree.
    expect(JSON.parse(readFileSync(result.manifest, 'utf8')).windows.x64.sha256).toBe(digest)
  })

  it('confirms the digest against the staged file, and refuses a file that changed under it', async () => {
    const result = await stage()
    await expect(confirmStagedInstaller({ installer: result.installer, sha256: result.sha256 })).resolves.toBeUndefined()
    // The confirmation is a reading of the file on disk, not a restatement of the digest the manifest
    // was built from, so it is only worth something if it can fail. This is that failure.
    writeFileSync(result.installer, 'bytes that arrived after the manifest was written')
    await expect(confirmStagedInstaller({ installer: result.installer, sha256: result.sha256 }))
      .rejects.toThrow(/hashes to/u)
  })

  it('refuses a development version, and stages nothing at all for it', async () => {
    await expect(stage({ files: { ...FROZEN, 'community-version.json': { communityVersion: '0.2-dev', upstreamBase: 'dsh-v0.2.0-rc.2' } } }))
      .rejects.toThrow(/release version/u)
    // Nothing is written, so a failed staging cannot be mistaken for a release worth uploading.
    expect(existsSync(out)).toBe(false)
  })

  it('refuses a tag that does not name the version, and stages nothing at all', async () => {
    for (const tag of ['community-v0.3', 'dsh-v0.2', 'community-v0.2-dev']) {
      await expect(stage({ tag })).rejects.toThrow(/does not name the version|not a Community release tag/u)
    }
    expect(existsSync(out)).toBe(false)
  })
})
