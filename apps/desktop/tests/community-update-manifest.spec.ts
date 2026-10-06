/**
 * The Community update manifest as untrusted input.
 *
 * A manifest arrives over the network and decides what an installation will download, so every case
 * here is written from the attacker's side of the boundary: the document claims more than the release
 * tooling can produce, and the reader has to refuse the whole thing. "Refuse the whole thing" is the
 * property worth pinning — a reader that dropped one bad field and kept the rest would accept a
 * manifest whose version was missing but whose installer was present, which is exactly the shape an
 * offered downgrade would take.
 *
 * The valid case is asserted in full rather than field by field, so a field added to the schema
 * without a matching case fails here, and the URL cases go through the same origin classifier the
 * download path uses: an asset address the identity does not own, or one served over plain HTTP, is
 * not a manifest problem to report but a download the client must never start.
 */
import { describe, expect, it } from 'vitest'
import {
  COMMUNITY_UPDATE_MAX_MANIFEST_BYTES,
  COMMUNITY_UPDATE_SCHEMA_VERSION,
  COMMUNITY_UPDATE_STABLE_CHANNEL,
  communityPlatformKeys,
  parseCommunityUpdateManifest,
  type CommunityUpdateManifestResult,
} from '../src/community-update-manifest.ts'
import {
  communityAssetUrl,
  communityReleasesUrl,
  parseCommunityRelease,
  type CommunityReleaseIdentity,
} from '../src/community-release.ts'

/** The identity the shipped file declares, so the URLs below are the ones a real build reads. */
const IDENTITY: CommunityReleaseIdentity = parseCommunityRelease(
  JSON.parse(String.raw`{"repository":"newplayer0408-jpg/deepseek-harness","manifest":"latest-community.json"}`),
)!

/** The installer name the fork publishes for Windows x64. */
const ASSET_NAME = 'DeepSeek-Harness-Community-v0.2-Windows-x64.exe'

/** A manifest body the release tooling really produces, with one field replaceable per case. */
function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: COMMUNITY_UPDATE_SCHEMA_VERSION,
    version: '0.2',
    channel: COMMUNITY_UPDATE_STABLE_CHANNEL,
    publishedAt: '2026-10-06T00:00:00.000Z',
    upstreamBase: 'dsh-v0.2.0-rc.2',
    releaseNotesUrl: `${communityReleasesUrl(IDENTITY)}/tag/community-v0.2`,
    windows: {
      x64: {
        fileName: ASSET_NAME,
        url: communityAssetUrl(IDENTITY, 'community-v0.2', ASSET_NAME),
        sha256: 'a'.repeat(64),
        size: 287558992,
      },
    },
    ...overrides,
  })
}

/** Validate one body for the one platform the fork publishes for. */
function read(text: string, platform = { os: 'win32', arch: 'x64' }): CommunityUpdateManifestResult {
  return parseCommunityUpdateManifest(text, IDENTITY, platform)
}

/** The fault one body is refused with. */
function faultOf(text: string, platform?: { readonly os: string; readonly arch: string }): unknown {
  const result = platform === undefined ? read(text) : read(text, platform)
  return result.kind === 'invalid' ? result.fault : `accepted as ${result.kind}`
}

describe('a manifest the release tooling produced', () => {
  it('reads every field, and reports the platform entry the running machine will use', () => {
    expect(read(body())).toEqual({
      kind: 'valid',
      manifest: {
        schemaVersion: COMMUNITY_UPDATE_SCHEMA_VERSION,
        version: '0.2',
        channel: COMMUNITY_UPDATE_STABLE_CHANNEL,
        publishedAt: '2026-10-06T00:00:00.000Z',
        upstreamBase: 'dsh-v0.2.0-rc.2',
        releaseNotesUrl: `${communityReleasesUrl(IDENTITY)}/tag/community-v0.2`,
        asset: {
          fileName: ASSET_NAME,
          url: communityAssetUrl(IDENTITY, 'community-v0.2', ASSET_NAME),
          sha256: 'a'.repeat(64),
          size: 287558992,
        },
      },
    })
  })

  it('accepts a body without the two optional facts, and without a declared size', () => {
    const minimal = JSON.stringify({
      schemaVersion: 1,
      version: '0.2',
      channel: 'stable',
      publishedAt: '2026-10-06T00:00:00.000Z',
      windows: {
        x64: {
          fileName: ASSET_NAME,
          url: communityAssetUrl(IDENTITY, 'community-v0.2', ASSET_NAME),
          sha256: 'b'.repeat(64),
        },
      },
    })
    const result = read(minimal)
    expect(result.kind).toBe('valid')
    if (result.kind !== 'valid') return
    // An absent fact stays absent rather than becoming an empty string a surface would render.
    expect(result.manifest).not.toHaveProperty('upstreamBase')
    expect(result.manifest).not.toHaveProperty('releaseNotesUrl')
    expect(result.manifest.asset).not.toHaveProperty('size')
  })

  it('maps the running platform and architecture to the section it reads', () => {
    expect(communityPlatformKeys('win32', 'x64')).toEqual({ platform: 'windows', arch: 'x64' })
    expect(communityPlatformKeys('win32', 'arm64')).toEqual({ platform: 'windows', arch: 'arm64' })
    expect(communityPlatformKeys('darwin', 'arm64')).toEqual({ platform: 'macos', arch: 'arm64' })
    expect(communityPlatformKeys('linux', 'x64')).toEqual({ platform: 'linux', arch: 'x64' })
    // A platform the manifest has no section for, and an architecture outside the two the fork builds.
    expect(communityPlatformKeys('freebsd', 'x64')).toBeUndefined()
    expect(communityPlatformKeys('win32', 'ia32')).toBeUndefined()
    expect(communityPlatformKeys('win32', '')).toBeUndefined()
  })
})

describe('a manifest that is not what the release tooling produces', () => {
  it('refuses a body that is not a JSON object, and one that is not JSON at all', () => {
    for (const text of ['', 'not json', '{', '"0.2"', 'null', '[]', '[1]', '42']) {
      expect(faultOf(text)).toBe('malformed-json')
    }
  })

  it('validates the schema version rather than assuming it', () => {
    expect(faultOf(body({ schemaVersion: 2 }))).toBe('unsupported-schema')
    expect(faultOf(body({ schemaVersion: 0 }))).toBe('unsupported-schema')
    expect(faultOf(body({ schemaVersion: '1' }))).toBe('unsupported-schema')
    expect(faultOf(body({ schemaVersion: undefined }))).toBe('unsupported-schema')
  })

  it('rejects anything but the stable channel, and a missing version', () => {
    for (const channel of ['dev', 'beta', 'Development', '', undefined, 1]) {
      expect(faultOf(body({ channel }))).toBe('invalid-channel')
    }
  })

  it('refuses a version the comparator could not order, and any prerelease', () => {
    for (const version of [undefined, '', 'latest', 2, 'v', '0.2.0.0.0']) {
      expect(faultOf(body({ version }))).toBe('invalid-version')
    }
    // A stable installation must never be offered a prerelease, so the reader refuses one outright:
    // this is what keeps a `-rc` build from arriving as an ordinary update.
    for (const version of ['0.2-dev', '0.4-rc.1', '0.2.0-alpha', '0.3.0-beta.1']) {
      expect(faultOf(body({ version }))).toBe('invalid-version')
    }
  })

  it('reads a version with the same parser the comparator will, so the two cannot disagree', () => {
    // Whitespace is not a version, but the parser trims before it matches, and the reader accepts
    // exactly what that parser produced — so a padded value is ordered as the version it names
    // rather than refused here and compared as something else later.
    const padded = read(body({ version: ' 0.2 ' }))
    expect(padded.kind).toBe('valid')
    if (padded.kind === 'valid') expect(padded.manifest.version).toBe(' 0.2 ')
  })

  it('requires a publication time it can parse', () => {
    for (const publishedAt of [undefined, '', 'yesterday', '2026-13-45T00:00:00Z', 0]) {
      expect(faultOf(body({ publishedAt }))).toBe('invalid-published-at')
    }
  })

  it('refuses an upstream base that is not an upstream release tag', () => {
    for (const upstreamBase of ['', 'v0.2', 'dsh-v', 'dsh-v0.2.0/../../evil', 'dsh-v0.2.0-rc.2 ', 2]) {
      expect(faultOf(body({ upstreamBase }))).toBe('invalid-upstream-base')
    }
    // An explicit null is a value, and a value outside the shape is refused like any other.
    expect(faultOf(body({ upstreamBase: null }))).toBe('invalid-upstream-base')
  })

  it('refuses a release page this repository does not own, or one that is not HTTPS', () => {
    for (const releaseNotesUrl of [
      '',
      'not a url',
      'https://evil.test/notes',
      'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2',
      `${communityReleasesUrl(IDENTITY)}/tag/x`.replace('https:', 'http:'),
      1,
    ]) {
      expect(faultOf(body({ releaseNotesUrl }))).toBe('invalid-release-notes-url')
    }
    expect(faultOf(body({ releaseNotesUrl: null }))).toBe('invalid-release-notes-url')
  })

  it('refuses an installer address that is not this repository\'s own asset', () => {
    const windows = (url: unknown): string => body({ windows: { x64: { fileName: ASSET_NAME, url, sha256: 'a'.repeat(64) } } })
    for (const url of [
      undefined,
      '',
      'not a url',
      // Plain HTTP, a local file, and a lookalike host.
      String(communityAssetUrl(IDENTITY, 'community-v0.2', ASSET_NAME)).replace('https:', 'http:'),
      'file:///C:/Users/secret/setup.exe',
      `https://evil.test/${ASSET_NAME}`,
      // The upstream repository's release, and GitHub's content host without a redirect to reach it.
      `https://github.com/deepseek-ai/deepseek-harness/releases/download/community-v0.2/${ASSET_NAME}`,
      `https://objects.githubusercontent.com/newplayer0408-jpg/deepseek-harness/${ASSET_NAME}`,
      // The repository's own pages, but not a release asset of it.
      communityReleasesUrl(IDENTITY),
    ]) {
      expect(faultOf(windows(url))).toBe('invalid-asset')
    }
  })

  it('refuses an installer entry whose name, digest, or size is outside its shape', () => {
    const entry = (overrides: Record<string, unknown>): string => body({
      windows: {
        x64: {
          fileName: ASSET_NAME,
          url: communityAssetUrl(IDENTITY, 'community-v0.2', ASSET_NAME),
          sha256: 'a'.repeat(64),
          ...overrides,
        },
      },
    })
    // A name that would escape the update directory, or one that is not an installer at all.
    for (const fileName of [undefined, '', 'setup.exe/../evil', '..\\setup.exe', 'nested/setup.exe', 7]) {
      expect(faultOf(entry({ fileName }))).toBe('invalid-asset')
    }
    // A digest that is missing, uppercase, the wrong length, or not hexadecimal.
    for (const sha256 of [undefined, '', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), 1]) {
      expect(faultOf(entry({ sha256 }))).toBe('invalid-asset')
    }
    // A declared size that could not be a byte count.
    for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, '1', null]) {
      expect(faultOf(entry({ size }))).toBe('invalid-asset')
    }
  })

  it('refuses a platform the document has no usable section for', () => {
    // No section at all, and a section that is not an object.
    expect(faultOf(body({ windows: undefined }))).toBe('unsupported-platform')
    expect(faultOf(body({ windows: 'windows' }))).toBe('unsupported-platform')
    expect(faultOf(body({ windows: [] }))).toBe('unsupported-platform')
    // A section that is present but has no entry for this architecture.
    expect(faultOf(body({ windows: { arm64: { fileName: ASSET_NAME, url: communityAssetUrl(IDENTITY, 'community-v0.2', ASSET_NAME), sha256: 'a'.repeat(64) } } }))).toBe('invalid-asset')
    // A platform the fork publishes no installer for is refused before any URL is considered.
    expect(faultOf(body(), { os: 'freebsd', arch: 'x64' })).toBe('unsupported-platform')
  })

  it('refuses the whole manifest when one field is wrong, rather than dropping that field', () => {
    // Every other field — including a usable installer — is intact, and the document is still refused:
    // a manifest whose version could not be ordered is not a manifest a client may act on.
    expect(faultOf(body({ version: '0.2-dev' }))).toBe('invalid-version')
    expect(faultOf(body({ publishedAt: 'never' }))).toBe('invalid-published-at')
    expect(faultOf(body({ upstreamBase: 'latest' }))).toBe('invalid-upstream-base')
  })

  it('bounds the body it will parse, and states that bound for the transport to enforce', () => {
    expect(COMMUNITY_UPDATE_MAX_MANIFEST_BYTES).toBe(512 * 1024)
    // The reader itself does not size the text it is handed: the transport applies the bound while
    // reading, which is the case `community-update-download.spec.ts` pins.
    expect(read(body())).toMatchObject({ kind: 'valid' })
  })
})
