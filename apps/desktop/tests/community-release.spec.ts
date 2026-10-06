/**
 * The fork's own release identity, and the URLs an installation is therefore allowed to read.
 *
 * The identity is the one fact that decides where every Community download goes, so these cases pin
 * it from both ends. The committed file must name the fork's own repository — read from the file the
 * build ships rather than from a literal here, so a hand-edited identity fails the suite instead of
 * silently sending installations somewhere else — and every URL built from it must stay inside that
 * repository. The refusal cases are the ones that matter most: an `http:` address, a credential-bearing
 * address, a lookalike host, another repository, and a path that tries to climb out of the release
 * directory all have to classify as `unknown` rather than as somewhere worth fetching.
 *
 * The variant gate is pinned separately, because it is what keeps a release installation from
 * acquiring a Community release source at all: the reader must answer before it opens the file.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  COMMUNITY_ASSET_HOSTS,
  COMMUNITY_RELEASE_FILE,
  COMMUNITY_RELEASE_HOST,
  COMMUNITY_RELEASE_TAG_PREFIX,
  communityAssetUrl,
  communityManifestUrl,
  communityRedirectAllowed,
  communityReleaseLocation,
  communityReleaseOrigin,
  communityReleasesUrl,
  parseCommunityRelease,
  readCommunityRelease,
  type CommunityReleaseIdentity,
} from '../src/community-release.ts'
import {
  DESKTOP_COMMUNITY_VARIANT,
  DESKTOP_DEV_VARIANT,
  DESKTOP_PRODUCTION_VARIANT,
} from '../src/desktop-variant.ts'

/** The identity the shipped file declares, read from the file itself rather than restated here. */
const SHIPPED = JSON.parse(readFileSync(fileURLToPath(new URL('../community-release.json', import.meta.url)), 'utf8')) as CommunityReleaseIdentity

/** The identity the cases below build URLs from. */
const IDENTITY: CommunityReleaseIdentity = SHIPPED

/** Every URL one repository owns, keyed by what it is. */
const OWNED_URLS = {
  manifest: communityManifestUrl(IDENTITY),
  asset: communityAssetUrl(IDENTITY, 'community-v0.2', 'DeepSeek-Harness-Community-v0.2-Windows-x64.exe')!,
  'release-page': communityReleasesUrl(IDENTITY),
} as const

describe('the identity one fork publishes from', () => {
  it('ships a file naming a repository, and the build reads that file rather than a constant', () => {
    expect(COMMUNITY_RELEASE_FILE).toBe('community-release.json')
    // A repository pair and a flat JSON name, as GitHub and the release workflow really write them.
    expect(SHIPPED.repository).toMatch(/^[^/]+\/[^/]+$/u)
    expect(SHIPPED.manifest).toMatch(/\.json$/u)
    // The one who publishes is the fork, never upstream: a release feed served by the upstream
    // repository would hand a Community installation the official product.
    expect(SHIPPED.repository).not.toContain('deepseek-ai')
  })

  it('accepts exactly the two fields it needs, and nothing else in their place', () => {
    expect(parseCommunityRelease(SHIPPED)).toEqual(SHIPPED)
    const refused: readonly unknown[] = [
      undefined,
      null,
      'newplayer0408-jpg/deepseek-harness',
      [],
      {},
      { repository: SHIPPED.repository },
      { manifest: SHIPPED.manifest },
      { repository: '', manifest: SHIPPED.manifest },
      // Half a pair, a path, a trailing slash, and a value that would become a URL segment.
      { repository: 'deepseek-harness', manifest: SHIPPED.manifest },
      { repository: 'newplayer0408-jpg/deepseek-harness/releases', manifest: SHIPPED.manifest },
      { repository: 'newplayer0408-jpg/', manifest: SHIPPED.manifest },
      { repository: '../deepseek-ai/deepseek-harness', manifest: SHIPPED.manifest },
      { repository: SHIPPED.repository, manifest: '' },
      { repository: SHIPPED.repository, manifest: '../../evil.json' },
      { repository: SHIPPED.repository, manifest: 'notes.txt' },
      { repository: SHIPPED.repository, manifest: 'nested/latest-community.json' },
    ]
    for (const source of refused) expect(parseCommunityRelease(source)).toBeUndefined()
  })

  it('reads no release source at all unless the build declares the community variant', async () => {
    const read = vi.fn(async () => JSON.stringify(SHIPPED))
    for (const variant of [DESKTOP_PRODUCTION_VARIANT, DESKTOP_DEV_VARIANT] as const) {
      expect(await readCommunityRelease({ appPath: 'app', variant, read })).toBeUndefined()
    }
    // The gate is before the read, which is what makes the file harmless on a release build.
    expect(read).not.toHaveBeenCalled()
    expect(await readCommunityRelease({ appPath: 'app', variant: DESKTOP_COMMUNITY_VARIANT, read })).toEqual(SHIPPED)
    expect(read).toHaveBeenCalledOnce()
  })

  it('answers nothing for a file that is missing, unreadable, or not a JSON object', async () => {
    const missing = async (): Promise<string> => { throw new Error('ENOENT') }
    expect(await readCommunityRelease({ appPath: 'app', variant: DESKTOP_COMMUNITY_VARIANT, read: missing })).toBeUndefined()
    for (const text of ['', 'not json', '"a string"', '[]', '[1,2]', 'null']) {
      const read = async (): Promise<string> => text
      expect(await readCommunityRelease({ appPath: 'app', variant: DESKTOP_COMMUNITY_VARIANT, read })).toBeUndefined()
    }
  })
})

describe('the addresses an installation may read', () => {
  it('builds the manifest, asset, and release page from the declared repository alone', () => {
    expect(OWNED_URLS.manifest).toBe(`https://${COMMUNITY_RELEASE_HOST}/${SHIPPED.repository}/releases/latest/download/${SHIPPED.manifest}`)
    expect(OWNED_URLS.asset).toBe(`https://${COMMUNITY_RELEASE_HOST}/${SHIPPED.repository}/releases/download/community-v0.2/DeepSeek-Harness-Community-v0.2-Windows-x64.exe`)
    expect(OWNED_URLS['release-page']).toBe(`https://${COMMUNITY_RELEASE_HOST}/${SHIPPED.repository}/releases`)
    // Nothing a URL carries can redirect the chain: the repository comes from the file, whole.
    for (const url of Object.values(OWNED_URLS)) expect(url.startsWith(`https://${COMMUNITY_RELEASE_HOST}/${SHIPPED.repository}/`)).toBe(true)
  })

  it('refuses to build an asset address from a tag or a file name outside its shape', () => {
    expect(communityAssetUrl(IDENTITY, 'community-v0.2', 'setup.exe')).toBeDefined()
    for (const tag of ['', 'v0.2', 'community-v', 'community-v0.2/../../evil', 'dsh-v0.2.0-rc.2']) {
      expect(communityAssetUrl(IDENTITY, tag, 'setup.exe')).toBeUndefined()
    }
    for (const file of ['', 'setup', 'setup.exe/../evil', 'setup.msi', '../../setup.exe', 'a/b.exe']) {
      expect(communityAssetUrl(IDENTITY, 'community-v0.2', file)).toBeUndefined()
    }
  })

  it('derives the tag, the asset address, and the release page from one version', () => {
    expect(communityReleaseLocation(IDENTITY, '0.2', 'setup.exe')).toEqual({
      tag: `${COMMUNITY_RELEASE_TAG_PREFIX}0.2`,
      assetUrl: communityAssetUrl(IDENTITY, 'community-v0.2', 'setup.exe')!,
      releaseUrl: `${communityReleasesUrl(IDENTITY)}/tag/community-v0.2`,
    })
    // A version the tag grammar cannot carry yields no location at all rather than a broken tag.
    for (const version of ['', 'v0.2', '0.2/../../evil', '0.2-dev']) {
      expect(communityReleaseLocation(IDENTITY, version, 'setup.exe')).toBeUndefined()
    }
  })

  it('classifies each address this repository owns', () => {
    expect(communityReleaseOrigin(OWNED_URLS.manifest, IDENTITY)).toBe('manifest')
    expect(communityReleaseOrigin(OWNED_URLS.asset, IDENTITY)).toBe('asset')
    expect(communityReleaseOrigin(OWNED_URLS['release-page'], IDENTITY)).toBe('release-page')
    expect(communityReleaseOrigin(`${communityReleasesUrl(IDENTITY)}/tag/community-v0.2`, IDENTITY)).toBe('release-page')
    expect(communityReleaseOrigin(`https://${COMMUNITY_ASSET_HOSTS[0]}/${SHIPPED.repository}/x.exe`, IDENTITY)).toBe('asset-host')
    // A manifest name the identity does not declare is a page, not a manifest.
    expect(communityReleaseOrigin(`${communityReleasesUrl(IDENTITY)}/latest/download/other.json`, IDENTITY)).toBe('release-page')
  })

  it('refuses every address that is not this repository\'s own', () => {
    const repository = SHIPPED.repository
    const refusals: readonly string[] = [
      // Not HTTPS, and not a URL at all.
      OWNED_URLS.manifest.replace('https:', 'http:'),
      OWNED_URLS.manifest.replace('https:', 'file:'),
      `${COMMUNITY_RELEASE_HOST}/${repository}/releases/latest/download/${SHIPPED.manifest}`,
      'not a url',
      '',
      // Credentials in the authority.
      `https://user:token@${COMMUNITY_RELEASE_HOST}/${repository}/releases/latest/download/${SHIPPED.manifest}`,
      // A lookalike host, and the upstream repository.
      `https://${COMMUNITY_RELEASE_HOST}.evil.test/${repository}/releases/latest/download/${SHIPPED.manifest}`,
      `https://evil.test/${repository}/releases/latest/download/${SHIPPED.manifest}`,
      `https://${COMMUNITY_RELEASE_HOST}/deepseek-ai/deepseek-harness/releases/latest/download/${SHIPPED.manifest}`,
      // Another section.
      `https://${COMMUNITY_RELEASE_HOST}/${repository}/issues`,
    ]
    for (const url of refusals) expect(communityReleaseOrigin(url, IDENTITY)).toBe('unknown')
  })

  it('never promotes a document the identity did not name to a manifest or an asset', () => {
    const repository = SHIPPED.repository
    const notDownloads: readonly string[] = [
      // A different file name in the manifest position, and a path that tries to climb out of the
      // release directory. Neither is fetched: the download path admits `manifest` and `asset` only.
      `https://${COMMUNITY_RELEASE_HOST}/${repository}/releases/latest/download/planted.json`,
      `https://${COMMUNITY_RELEASE_HOST}/${repository}/releases/latest/download/..%2f..%2f..%2fdeepseek-ai%2fdeepseek-harness%2freleases%2flatest%2fdownload%2flatest-community.json`,
      `https://${COMMUNITY_RELEASE_HOST}/${repository}/releases/download/community-v0.2/`,
      `https://${COMMUNITY_RELEASE_HOST}/${repository}/releases`,
    ]
    for (const url of notDownloads) {
      const origin = communityReleaseOrigin(url, IDENTITY)
      expect(origin).not.toBe('manifest')
      expect(origin).not.toBe('asset')
    }
  })

  it('follows exactly one hop, from a release address into the asset host', () => {
    const assetHost = `https://${COMMUNITY_ASSET_HOSTS[0]}/${SHIPPED.repository}/x.exe`
    expect(communityRedirectAllowed(OWNED_URLS.asset, assetHost, IDENTITY)).toBe(true)
    expect(communityRedirectAllowed(OWNED_URLS.manifest, assetHost, IDENTITY)).toBe(true)
    // Between two asset hosts, when the service moves a download internally.
    expect(communityRedirectAllowed(assetHost, `https://${COMMUNITY_ASSET_HOSTS[1]}/${SHIPPED.repository}/x.exe`, IDENTITY)).toBe(true)
    // Anywhere else, including back into the repository and out to a third party.
    expect(communityRedirectAllowed(OWNED_URLS.asset, OWNED_URLS.manifest, IDENTITY)).toBe(false)
    expect(communityRedirectAllowed(OWNED_URLS.asset, OWNED_URLS['release-page'], IDENTITY)).toBe(false)
    expect(communityRedirectAllowed(OWNED_URLS.asset, 'https://evil.test/x.exe', IDENTITY)).toBe(false)
    expect(communityRedirectAllowed(OWNED_URLS.asset, `http://${COMMUNITY_ASSET_HOSTS[0]}/x.exe`, IDENTITY)).toBe(false)
    // A hop from a URL this repository does not own is refused whatever it points at, so an
    // unacceptable first response can never be laundered into an acceptable second one.
    expect(communityRedirectAllowed('https://evil.test/x.exe', assetHost, IDENTITY)).toBe(false)
  })
})
