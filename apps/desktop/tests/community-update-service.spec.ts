/**
 * The Community update state machine: one installation's own update story from asking to having a
 * verified installer on disk.
 *
 * Every seam is a literal here — the network is a scripted transport, the disk is an in-memory store,
 * and the version facts are data — so each phase, including the four failure phases, is reachable
 * without a socket or a filesystem. That matters because the failure phases are the ones a real
 * machine reaches rarely and a wrong implementation reaches silently.
 *
 * Two cases carry the security properties rather than the happy path. A refused checksum must leave
 * *nothing* behind: the staged file is discarded and no stored file is reported, so the surface has no
 * file to offer. And a download must be refused unless a check is currently offering one, so a
 * manifest that was never compared with this build can never be fetched.
 *
 * The channel cases are the third property, and they are asymmetric on purpose: a release installation
 * ignores every prerelease, and a development installation ignores every release. `0.2-dev` is never
 * silently replaced by `0.2`, which is what keeps a developer on the line they asked for.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  CommunityUpdateService,
  type CommunityUpdateProgress,
  type CommunityUpdateStagedFile,
  type CommunityUpdateState,
  type CommunityUpdateStore,
  type CommunityUpdateStoredFile,
} from '../src/community-update-service.ts'
import type { CommunityUpdateReply, CommunityUpdateTransport } from '../src/community-update-download.ts'
import type { CommunityVersionIdentity } from '../src/community-version.ts'
import {
  COMMUNITY_ASSET_HOSTS,
  communityAssetUrl,
  communityManifestUrl,
  communityReleasesUrl,
  parseCommunityRelease,
  type CommunityReleaseIdentity,
} from '../src/community-release.ts'

/** The identity the shipped file declares, so the addresses below are the ones a real build reads. */
const IDENTITY: CommunityReleaseIdentity = parseCommunityRelease(
  JSON.parse(String.raw`{"repository":"newplayer0408-jpg/deepseek-harness","manifest":"latest-community.json"}`),
)!

/** The installer name the fork publishes for Windows x64. */
const ASSET_NAME = 'DeepSeek-Harness-Community-v0.2-Windows-x64.exe'

/** The asset address the identity derives for one release. */
const ASSET_URL = communityAssetUrl(IDENTITY, 'community-v0.3', ASSET_NAME)!

/** Bytes standing in for an installer, and the digest a manifest records for them. */
const BYTES = Buffer.from('installer bytes')
const DIGEST = createHash('sha256').update(BYTES).digest('hex')

/** The directory the in-memory store reports, matching the symbolic form the wiring produces. */
const UPDATES = '~/.dsh-community/updates'

/** The fork's development line, which is what this build reports. */
const DEVELOPMENT: CommunityVersionIdentity = { version: 'v0.2-dev', upstreamBase: 'dsh-v0.2.0-rc.2' }

/** The fork's release line. */
const RELEASE: CommunityVersionIdentity = { version: 'v0.2', upstreamBase: 'dsh-v0.2.0-rc.2' }

/** A manifest body offering one version and one installer. */
function manifestBody(overrides: { readonly version?: string; readonly sha256?: string; readonly size?: number } = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    version: overrides.version ?? '0.3',
    channel: 'stable',
    publishedAt: '2026-10-06T00:00:00.000Z',
    upstreamBase: 'dsh-v0.2.0-rc.2',
    releaseNotesUrl: `${communityReleasesUrl(IDENTITY)}/tag/community-v0.3`,
    windows: {
      x64: {
        fileName: ASSET_NAME,
        url: ASSET_URL,
        sha256: overrides.sha256 ?? DIGEST,
        ...overrides.size === undefined ? {} : { size: overrides.size },
      },
    },
  })
}

/** One body, delivered as a real async iterable rather than an array. */
async function *chunks(...parts: readonly (Uint8Array | string)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part) : part
}

/** A transport that answers the manifest address from one body and the asset from another. */
function transport(text: string, assetBytes: readonly Uint8Array[] = [BYTES]): CommunityUpdateTransport & { readonly asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    request: async (url: string): Promise<CommunityUpdateReply> => {
      asked.push(url)
      if (url === communityManifestUrl(IDENTITY)) return { kind: 'body', status: 200, body: chunks(text) }
      if (url === ASSET_URL) return { kind: 'body', status: 200, body: chunks(...assetBytes) }
      throw new Error(`unexpected request for ${url}`)
    },
  }
}

/** The in-memory staging directory, as the service sees it plus what it must be able to observe. */
interface FakeStore extends CommunityUpdateStore {
  readonly writes: readonly Uint8Array[]
  readonly stagedNames: readonly string[]
  readonly discarded: number
  failStage: boolean
  failCommit: boolean
}

/** One in-memory staging directory, able to refuse a write or a promotion on demand. */
function store(): FakeStore {
  const state = {
    writes: [] as Uint8Array[],
    stagedNames: [] as string[],
    discarded: 0,
    failStage: false,
    failCommit: false,
  }
  return {
    get writes(): readonly Uint8Array[] { return state.writes },
    get stagedNames(): readonly string[] { return state.stagedNames },
    get discarded(): number { return state.discarded },
    get failStage(): boolean { return state.failStage },
    set failStage(value: boolean) { state.failStage = value },
    get failCommit(): boolean { return state.failCommit },
    set failCommit(value: boolean) { state.failCommit = value },
    async stage(name: string): Promise<CommunityUpdateStagedFile> {
      if (state.failStage) throw new Error('EACCES')
      state.stagedNames.push(name)
      return {
        fileName: name,
        directory: UPDATES,
        write: async (chunk: Uint8Array): Promise<void> => { state.writes.push(chunk) },
        commit: async (): Promise<CommunityUpdateStoredFile> => {
          if (state.failCommit) throw new Error('EPERM')
          return { fileName: name, directory: UPDATES, size: BYTES.byteLength }
        },
      }
    },
    async discard(): Promise<void> {
      state.discarded += 1
      state.writes.length = 0
      state.stagedNames.length = 0
    },
    async stored(): Promise<CommunityUpdateStoredFile | undefined> {
      const name = state.stagedNames.at(-1)
      return name === undefined ? undefined : { fileName: name, directory: UPDATES, size: BYTES.byteLength }
    },
  }
}

/** Build one service over scripted seams, recording every phase and progress report it publishes. */
function service(options: {
  readonly text?: string
  readonly community?: CommunityVersionIdentity | undefined
  readonly identity?: CommunityReleaseIdentity | undefined
  readonly platform?: { readonly os: string; readonly arch: string }
  readonly transport?: CommunityUpdateTransport
  readonly store?: CommunityUpdateStore
} = {}): {
  readonly service: CommunityUpdateService
  readonly phases: string[]
  readonly progress: CommunityUpdateProgress[]
} {
  const phases: string[] = []
  const progress: CommunityUpdateProgress[] = []
  const instance = new CommunityUpdateService({
    // Presence rather than truthiness decides: a case asking for a build with *no* release source
    // passes the property explicitly, which is the only way to tell that apart from the default.
    identity: 'identity' in options ? options.identity : IDENTITY,
    community: 'community' in options ? options.community : DEVELOPMENT,
    platform: options.platform ?? { os: 'win32', arch: 'x64' },
    transport: options.transport ?? transport(options.text ?? manifestBody()),
    store: options.store ?? store(),
    onChange: (state: CommunityUpdateState) => {
      phases.push(state.phase)
      if (state.progress !== undefined) progress.push(state.progress)
    },
  })
  return { service: instance, phases, progress }
}

describe('the state one installation starts in', () => {
  it('reports the version, the channel, and the release repository it was built for', () => {
    expect(service().service.state()).toEqual({
      phase: 'idle',
      currentVersion: 'v0.2-dev',
      channel: 'development',
      source: IDENTITY.repository,
    })
  })

  it('names the fact that is missing instead of looking checked', () => {
    // A build whose release source could not be read has nowhere to check, and says so.
    expect(service({ identity: undefined }).service.state()).toMatchObject({ phase: 'idle', source: '', fault: 'no-source' })
    // A build that read a source but no version facts cannot compare anything.
    expect(service({ community: undefined }).service.state())
      .toMatchObject({ phase: 'idle', currentVersion: '', channel: 'unknown', fault: 'no-version' })
    // Both missing leaves one fault, not two: the source is the first step that cannot be taken.
    expect(service({ identity: undefined, community: undefined }).service.state()).toMatchObject({ fault: 'no-source' })
  })

  it('does not ask the network when it has no source to ask', async () => {
    const asked = vi.fn()
    const instance = service({ identity: undefined, transport: { request: asked } })
    expect(await instance.service.check()).toMatchObject({ phase: 'idle', fault: 'no-source' })
    // The manifest address cannot even be built without a repository, so nothing is requested.
    expect(asked).not.toHaveBeenCalled()
  })
})

describe('checking for an update', () => {
  it('reports the release line as the latest when the running build is on it', async () => {
    const state = await service({ text: manifestBody({ version: '0.2' }), community: RELEASE }).service.check()
    expect(state).toMatchObject({ phase: 'up-to-date', latestVersion: 'v0.2', manifestSchema: 1, channel: 'release' })
  })

  it('reaches up-to-date through the redirect chain a published release really answers with', async () => {
    // The failure this pins, end to end: Community v0.2 published, its manifest naming the same
    // version the installation runs, and GitHub answering in two hops. Before the versioned manifest
    // address was classified apart from an installer asset, the first hop was refused — so a build
    // that was up to date reported `network-error` for a release that was published and reachable.
    const manifest = communityManifestUrl(IDENTITY)
    const versioned = `https://github.com/${IDENTITY.repository}/releases/download/community-v0.2/${IDENTITY.manifest}`
    const served = `https://${COMMUNITY_ASSET_HOSTS[2]}/${IDENTITY.repository}/${IDENTITY.manifest}`
    const asked: string[] = []
    const chained: CommunityUpdateTransport = {
      request: async (url: string): Promise<CommunityUpdateReply> => {
        asked.push(url)
        if (url === manifest) return { kind: 'redirect', status: 302, location: versioned }
        if (url === versioned) return { kind: 'redirect', status: 302, location: served }
        if (url === served) return { kind: 'body', status: 200, body: chunks(manifestBody({ version: '0.2' })) }
        throw new Error(`unexpected request for ${url}`)
      },
    }
    const instance = service({ transport: chained, community: RELEASE })
    const state = await instance.service.check()
    expect(state).toMatchObject({
      phase: 'up-to-date',
      currentVersion: 'v0.2',
      latestVersion: 'v0.2',
      channel: 'release',
      source: IDENTITY.repository,
    })
    // Neither of the two failures the surface could have shown instead.
    expect(state.fault).toBeUndefined()
    expect(instance.phases).toEqual(['checking', 'up-to-date'])
    expect(asked).toEqual([manifest, versioned, served])
  })

  it('offers a newer stable release, with the facts the surface shows beside it', async () => {
    const instance = service({ text: manifestBody({ version: '0.3' }), community: RELEASE })
    expect(await instance.service.check()).toMatchObject({
      phase: 'update-available',
      currentVersion: 'v0.2',
      latestVersion: 'v0.3',
      upstreamBase: 'dsh-v0.2.0-rc.2',
      publishedAt: '2026-10-06T00:00:00.000Z',
      releaseNotesUrl: `${communityReleasesUrl(IDENTITY)}/tag/community-v0.3`,
      manifestSchema: 1,
    })
    expect(instance.phases).toEqual(['checking', 'update-available'])
  })

  it('ignores an older release rather than offering a downgrade', async () => {
    for (const version of ['0.1', '0.1.9']) {
      expect(await service({ text: manifestBody({ version }), community: RELEASE }).service.check())
        .toMatchObject({ phase: 'up-to-date', latestVersion: `v${version}` })
    }
  })

  it('never offers a development build the release line, so the line a user is on decides', async () => {
    // The development line is what this build reports, so a released installer is not its update.
    for (const version of ['0.3', '0.4']) {
      expect(await service({ text: manifestBody({ version }) }).service.check())
        .toMatchObject({ phase: 'up-to-date', channel: 'development' })
    }
  })

  it('never offers a release build a prerelease, because the manifest reader refuses one first', async () => {
    // The stable manifest cannot even publish a prerelease, so this is a two-layer refusal: the body
    // is refused as invalid rather than compared and then ignored.
    for (const version of ['0.4-rc.1', '0.3-beta', '0.3-dev']) {
      expect(await service({ text: manifestBody({ version }), community: RELEASE }).service.check())
        .toMatchObject({ phase: 'invalid-manifest', fault: 'invalid-version' })
    }
  })

  it('reports an unreachable release host as a network problem, not as an unusable release', async () => {
    for (const reason of ['network', 'timeout'] as const) {
      const instance = service({ transport: { request: async () => ({ kind: 'failure', reason }) } })
      expect(await instance.service.check()).toMatchObject({ phase: 'network-error', fault: reason })
    }
    const rejecting = service({ transport: { request: async () => { throw new Error('ECONNREFUSED') } } })
    expect(await rejecting.service.check()).toMatchObject({ phase: 'network-error', fault: 'network' })
  })

  it('separates a release file nobody should act on from a platform with no installer', async () => {
    for (const [text, fault] of [
      ['not json', 'malformed-json'],
      [JSON.stringify({ schemaVersion: 2 }), 'unsupported-schema'],
      [manifestBody({ sha256: 'not-a-digest' }), 'invalid-asset'],
    ] as const) {
      expect(await service({ text }).service.check()).toMatchObject({ phase: 'invalid-manifest', fault })
    }
    // No section for this platform is its own phase, because the user's next step differs.
    expect(await service({ platform: { os: 'linux', arch: 'x64' } }).service.check())
      .toMatchObject({ phase: 'unsupported-platform', fault: 'unsupported-platform' })
  })

  it('asks the manifest address of the declared repository, exactly once per check', async () => {
    const seam = transport(manifestBody())
    await service({ transport: seam }).service.check()
    expect(seam.asked).toEqual([communityManifestUrl(IDENTITY)])
  })

  it('drops a manifest a later check no longer offers, so a stale result cannot be downloaded', async () => {
    // The same service checking twice: the second answer is the one that counts, and it clears the
    // manifest the first one offered rather than leaving an option behind.
    let version = '0.3'
    const instance = new CommunityUpdateService({
      identity: IDENTITY,
      community: RELEASE,
      platform: { os: 'win32', arch: 'x64' },
      transport: { request: async () => ({ kind: 'body', status: 200, body: chunks(manifestBody({ version })) }) },
      store: store(),
    })
    expect(await instance.check()).toMatchObject({ phase: 'update-available', latestVersion: 'v0.3' })
    version = '0.2'
    expect(await instance.check()).toMatchObject({ phase: 'up-to-date', latestVersion: 'v0.2' })
    expect(await instance.download()).toMatchObject({ phase: 'idle', fault: 'no-version' })
  })
})

describe('downloading the offered installer', () => {
  it('refuses to transfer anything until a check has offered something', async () => {
    const seam = transport(manifestBody())
    const instance = service({ transport: seam, community: RELEASE })
    expect(await instance.service.download()).toMatchObject({ phase: 'idle', fault: 'no-version' })
    // The check that never ran is what makes this a refusal rather than a fetch.
    expect(seam.asked).toEqual([])
  })

  it('passes through downloading, verifying, downloaded, and ready in that order', async () => {
    const destination = store()
    const instance = service({ text: manifestBody({ size: BYTES.byteLength }), community: RELEASE, store: destination })
    await instance.service.check()
    expect(await instance.service.download()).toMatchObject({
      phase: 'ready',
      latestVersion: 'v0.3',
      verifiedSha256: DIGEST,
      progress: { received: BYTES.byteLength, total: BYTES.byteLength, percent: 100, fileName: ASSET_NAME, directory: UPDATES },
    })
    // The phases a user watches, including the two that exist only between a transfer and a file.
    expect(instance.phases)
      .toEqual(['checking', 'update-available', 'downloading', 'verifying', 'downloaded', 'ready'])
    // The staged bytes were written, and the file was committed under the name the manifest declared.
    expect(destination.writes).toHaveLength(1)
    expect(destination.stagedNames).toEqual([ASSET_NAME])
    expect(destination.discarded).toBe(0)
    expect(instance.service.storedFile()).toEqual({ fileName: ASSET_NAME, directory: UPDATES, size: BYTES.byteLength })
  })

  it('reports transfer progress as it arrives, with a percentage when a size was declared', async () => {
    const half = Buffer.from('installer')
    const rest = Buffer.from(' bytes')
    const size = half.byteLength + rest.byteLength
    const instance = service({
      text: manifestBody({ size }),
      community: RELEASE,
      transport: transport(manifestBody({ size }), [half, rest]),
    })
    await instance.service.check()
    await instance.service.download()
    // One report per chunk, then the same completed count on the two phases that follow: the surface
    // keeps showing the finished amount while the file is verified and promoted.
    expect(instance.progress.map(entry => entry.received)).toEqual([half.byteLength, size, size, size])
    expect(instance.progress.at(-1)?.percent).toBe(100)
  })

  it('leaves nothing behind when the digest does not match the published one', async () => {
    const destination = store()
    // A manifest whose digest is not this file's: every byte arrives and the file is still refused.
    const instance = service({ text: manifestBody({ sha256: 'b'.repeat(64), size: BYTES.byteLength }), community: RELEASE, store: destination })
    await instance.service.check()
    expect(await instance.service.download()).toMatchObject({ phase: 'checksum-error', fault: 'checksum-mismatch' })
    // The staging directory is cleaned and the surface has nothing to offer: a refused download may
    // not become a file a user runs by hand.
    expect(destination.discarded).toBe(1)
    expect(destination.writes).toEqual([])
    expect(instance.service.storedFile()).toBeUndefined()
    expect(instance.phases).not.toContain('ready')
  })

  it('reports a truncated transfer as a download failure rather than as a checksum failure', async () => {
    const destination = store()
    const instance = service({ text: manifestBody({ size: BYTES.byteLength + 1 }), community: RELEASE, store: destination })
    await instance.service.check()
    expect(await instance.service.download()).toMatchObject({ phase: 'download-error', fault: 'size-mismatch' })
    expect(destination.discarded).toBe(1)
    expect(instance.service.storedFile()).toBeUndefined()
  })

  it('reports a lost connection during the transfer, and discards the partial file', async () => {
    const destination = store()
    const instance = service({
      text: manifestBody(),
      community: RELEASE,
      store: destination,
      transport: {
        request: async (url: string) => url === communityManifestUrl(IDENTITY)
          ? { kind: 'body', status: 200, body: chunks(manifestBody()) }
          : { kind: 'failure', reason: 'network' },
      },
    })
    await instance.service.check()
    expect(await instance.service.download()).toMatchObject({ phase: 'network-error', fault: 'network' })
    expect(destination.discarded).toBe(1)
    expect(instance.service.storedFile()).toBeUndefined()
  })

  it('reports a staging directory it cannot write to, rather than throwing at the surface', async () => {
    const destination = store()
    destination.failStage = true
    const instance = service({ text: manifestBody(), community: RELEASE, store: destination })
    await instance.service.check()
    expect(await instance.service.download()).toMatchObject({ phase: 'download-error', fault: 'network' })
    expect(instance.service.storedFile()).toBeUndefined()
  })

  it('reports a file it cannot promote, and cleans the staged bytes it will not keep', async () => {
    const destination = store()
    destination.failCommit = true
    const instance = service({ text: manifestBody(), community: RELEASE, store: destination })
    await instance.service.check()
    expect(await instance.service.download()).toMatchObject({ phase: 'download-error', fault: 'network' })
    expect(destination.discarded).toBe(1)
    expect(instance.service.storedFile()).toBeUndefined()
  })
})

describe('what one service does while an operation is already running', () => {
  it('joins a check in flight instead of asking the release host twice', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let requests = 0
    const instance = service({
      community: RELEASE,
      transport: {
        request: async () => {
          requests += 1
          await gate
          return { kind: 'body', status: 200, body: chunks(manifestBody({ version: '0.3' })) }
        },
      },
    })
    const first = instance.service.check()
    const second = instance.service.check()
    release?.()
    expect(await first).toMatchObject({ phase: 'update-available' })
    expect(await second).toEqual(await first)
    // Two callers, one request: a second transfer against the same staging file is what this avoids.
    expect(requests).toBe(1)
    expect(instance.phases.filter(phase => phase === 'checking')).toHaveLength(1)
    // A later check is a fresh one rather than the promise that already settled.
    await instance.service.check()
    expect(requests).toBe(2)
  })

  it('keeps the last state after a dispose, so a closed surface still reports the truth', () => {
    const instance = service()
    instance.service.dispose()
    expect(instance.service.state()).toMatchObject({ phase: 'idle', source: IDENTITY.repository })
  })
})
