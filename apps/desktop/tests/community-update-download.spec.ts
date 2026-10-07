/**
 * Reading a Community update over the network, and proving what arrived is what was published.
 *
 * The transport is a seam, so every branch below is reachable without a socket: a redirect, a
 * redirect loop, a response that is not a success, an aborted body, and a body that is simply the
 * wrong bytes. The cases are grouped by the two properties the module exists for.
 *
 * The first is that a download is *checked rather than trusted*, and the case that proves it is the
 * digest one: the manifest's SHA-256 does not match the bytes, so the transfer has to fail with
 * `checksum-mismatch` even though every byte arrived and the length was right. A version of this
 * module that skipped the digest would pass every other case in this file, which is why that one is
 * here rather than left to a service-level case.
 *
 * The second is that redirects are a policy rather than a setting: each hop is judged against the
 * declared repository, so a chain that leaves it is refused, and a chain that never ends is refused
 * by the cap instead of by an endless read.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  COMMUNITY_UPDATE_MAX_REDIRECTS,
  downloadCommunityUpdateAsset,
  fetchCommunityUpdateManifest,
  type CommunityUpdateReply,
  type CommunityUpdateSink,
  type CommunityUpdateTransport,
} from '../src/community-update-download.ts'
import {
  COMMUNITY_UPDATE_MAX_MANIFEST_BYTES,
  type CommunityUpdateAsset,
} from '../src/community-update-manifest.ts'
import {
  COMMUNITY_ASSET_HOSTS,
  communityAssetUrl,
  communityManifestUrl,
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

/** The asset URL the identity derives for this release. */
const ASSET_URL = communityAssetUrl(IDENTITY, 'community-v0.2', ASSET_NAME)!

/** The address a release asset really redirects to. */
const ASSET_HOST_URL = `https://${COMMUNITY_ASSET_HOSTS[0]}/newplayer0408-jpg/deepseek-harness/${ASSET_NAME}`

/**
 * The versioned address GitHub answers the stable manifest address with, as the published release
 * answered it.
 *
 * It is written here rather than built by any function in the module under test, because nothing in
 * this fork composes it: it exists only as a redirect target GitHub itself names.
 */
const VERSIONED_MANIFEST_URL = `https://github.com/${IDENTITY.repository}/releases/download/community-v0.2/${IDENTITY.manifest}`

/**
 * The content host address that versioned manifest really redirects to, host and query included.
 *
 * The signed query string is the recorded shape with its signature replaced, so the hop is the real
 * one without carrying a live credential. The replacement is deliberately free of characters a URL
 * normalisation would re-encode, so the address a case scripts is the address the client resolves.
 */
const MANIFEST_ASSET_HOST_URL = 'https://release-assets.githubusercontent.com/github-production-release-asset/1386593265/f15f5349-cde9-4030-a64d-41eff769b844?sp=r&sv=2018-11-09&sr=b&spr=https&sig=REDACTED'

/** Bytes standing in for an installer, and the digest the manifest would record for them. */
const BYTES = Buffer.from('a small installer, standing in for a 287 MB one')
const DIGEST = createHash('sha256').update(BYTES).digest('hex')

/** A manifest body the release tooling really produces. */
function manifestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    version: '0.2',
    channel: 'stable',
    publishedAt: '2026-10-06T00:00:00.000Z',
    windows: { x64: { fileName: ASSET_NAME, url: ASSET_URL, sha256: DIGEST, size: BYTES.byteLength } },
    ...overrides,
  })
}

/** One chunk sequence, delivered as a real async iterable rather than an array. */
async function *chunks(...parts: readonly (Uint8Array | string)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part) : part
}

/** A body that fails part-way through, after delivering the chunks it was given. */
async function *failing(chunks: readonly Uint8Array[], error: Error): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk
  throw error
}

/** A transport that answers a scripted reply per URL, and records what it was asked for. */
function transportFor(replies: Readonly<Record<string, CommunityUpdateReply>>): CommunityUpdateTransport & { readonly asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    request: async (url: string): Promise<CommunityUpdateReply> => {
      asked.push(url)
      const reply = replies[url]
      if (reply === undefined) throw new Error(`unexpected request for ${url}`)
      return reply
    },
  }
}

/** A transport that answers every URL with the same reply. */
function answering(reply: CommunityUpdateReply): CommunityUpdateTransport {
  return { request: async () => reply }
}

/** The bytes one sink received. */
function sink(): CommunityUpdateSink & { readonly written: number } {
  const parts: Buffer[] = []
  return {
    get written(): number { return parts.reduce((total, part) => total + part.byteLength, 0) },
    write: async (chunk: Uint8Array): Promise<void> => { parts.push(Buffer.from(chunk)) },
  }
}

/** The asset entry a manifest would carry for these bytes, with one field replaceable. */
function asset(overrides: Partial<CommunityUpdateAsset> = {}): CommunityUpdateAsset {
  return { fileName: ASSET_NAME, url: ASSET_URL, sha256: DIGEST, size: BYTES.byteLength, ...overrides }
}

/**
 * The same installer as a manifest that declared no size for it.
 *
 * The field is absent rather than zero: an absent size leaves the ceiling to the transport, while a
 * zero would claim the release published an empty file.
 */
function unsized(): CommunityUpdateAsset {
  const { size: _declared, ...rest } = asset()
  return rest
}

describe('reading the manifest', () => {
  it('returns the validated manifest of a body the release tooling produced', async () => {
    const result = await fetchCommunityUpdateManifest(
      answering({ kind: 'body', status: 200, body: chunks(manifestBody()) }),
      communityManifestUrl(IDENTITY),
      IDENTITY,
      { os: 'win32', arch: 'x64' },
    )
    expect(result).toMatchObject({ kind: 'valid', manifest: { version: '0.2', channel: 'stable' } })
  })

  it('reads a body that arrives in several chunks, and one that is slow to arrive', async () => {
    const text = manifestBody()
    const split = [text.slice(0, 20), text.slice(20, 40), text.slice(40)]
    const result = await fetchCommunityUpdateManifest(
      answering({ kind: 'body', status: 200, body: chunks(...split) }),
      communityManifestUrl(IDENTITY),
      IDENTITY,
      { os: 'win32', arch: 'x64' },
    )
    expect(result.kind).toBe('valid')
  })

  it('distinguishes an unreachable host from a body that failed validation', async () => {
    const url = communityManifestUrl(IDENTITY)
    // The two are different things to tell a user, so the client may not collapse them into one.
    for (const reason of ['network', 'timeout'] as const) {
      expect(await fetchCommunityUpdateManifest(answering({ kind: 'failure', reason }), url, IDENTITY, { os: 'win32', arch: 'x64' }))
        .toEqual({ kind: 'unreachable', fault: reason })
    }
    // A transport that rejects is a transport failure too, not a manifest problem.
    const rejecting: CommunityUpdateTransport = { request: async () => { throw new Error('ECONNRESET') } }
    expect(await fetchCommunityUpdateManifest(rejecting, url, IDENTITY, { os: 'win32', arch: 'x64' }))
      .toEqual({ kind: 'unreachable', fault: 'network' })
    // A body that arrived and did not validate is reported as a refusal, not as unreachable.
    expect(await fetchCommunityUpdateManifest(
      answering({ kind: 'body', status: 200, body: chunks('not json') }), url, IDENTITY, { os: 'win32', arch: 'x64' },
    )).toEqual({ kind: 'invalid', fault: 'malformed-json' })
  })

  it('refuses a response that is not a success rather than reading an error page', async () => {
    for (const status of [400, 403, 404, 418, 500, 503]) {
      expect(await fetchCommunityUpdateManifest(
        answering({ kind: 'body', status, body: chunks('<html>Not Found</html>') }),
        communityManifestUrl(IDENTITY),
        IDENTITY,
        { os: 'win32', arch: 'x64' },
      )).toEqual({ kind: 'unreachable', fault: 'http-status' })
    }
  })

  it('bounds the body, and reports an aborted read as a network failure', async () => {
    const url = communityManifestUrl(IDENTITY)
    const oversized = Buffer.alloc(COMMUNITY_UPDATE_MAX_MANIFEST_BYTES + 1, 0x20)
    expect(await fetchCommunityUpdateManifest(
      answering({ kind: 'body', status: 200, body: chunks(oversized) }), url, IDENTITY, { os: 'win32', arch: 'x64' },
    )).toEqual({ kind: 'unreachable', fault: 'too-large' })
    expect(await fetchCommunityUpdateManifest(
      answering({ kind: 'body', status: 200, body: failing([Buffer.from('{')], new Error('socket hang up')) }),
      url,
      IDENTITY,
      { os: 'win32', arch: 'x64' },
    )).toEqual({ kind: 'unreachable', fault: 'network' })
  })

  it('asks for the manifest address, and refuses to read one the identity does not own', async () => {
    const manifest = communityManifestUrl(IDENTITY)
    const transport = transportFor({ [manifest]: { kind: 'body', status: 200, body: chunks(manifestBody()) } })
    await fetchCommunityUpdateManifest(transport, manifest, IDENTITY, { os: 'win32', arch: 'x64' })
    expect(transport.asked).toEqual([manifest])
    // An address outside the declared repository is refused before any request is made, whatever the
    // caller passes: the guarantee belongs to this function, not to its callers.
    for (const refused of [
      manifest.replace('https:', 'http:'),
      'file:///C:/Users/secret/latest-community.json',
      `https://evil.test/${IDENTITY.repository}/releases/latest/download/latest-community.json`,
      `${communityReleasesUrl(IDENTITY)}/latest/download/planted.json`,
      communityReleasesUrl(IDENTITY),
    ]) {
      const unreachable = transportFor({})
      expect(await fetchCommunityUpdateManifest(unreachable, refused, IDENTITY, { os: 'win32', arch: 'x64' }))
        .toEqual({ kind: 'unreachable', fault: 'redirect-refused' })
      expect(unreachable.asked).toEqual([])
    }
  })
})

/**
 * The chain GitHub really answers the stable manifest address with.
 *
 * This is the regression the release exposed. GitHub does not serve the asset from the stable
 * address in one hop: it first redirects to the release's own versioned path on `github.com`, and
 * only that path redirects to the content host. A policy that admits the second hop but not the
 * first rejects a chain GitHub just answered, which is exactly what `redirect-refused` reported for
 * an installation whose manifest was published and reachable.
 */
describe('the redirect chain GitHub really answers', () => {
  it('reads a published manifest through the versioned address, rather than refusing the first hop', async () => {
    const transport = transportFor({
      [communityManifestUrl(IDENTITY)]: { kind: 'redirect', status: 302, location: VERSIONED_MANIFEST_URL },
      [VERSIONED_MANIFEST_URL]: { kind: 'redirect', status: 302, location: MANIFEST_ASSET_HOST_URL },
      [MANIFEST_ASSET_HOST_URL]: { kind: 'body', status: 200, body: chunks(manifestBody()) },
    })
    const result = await fetchCommunityUpdateManifest(transport, communityManifestUrl(IDENTITY), IDENTITY, { os: 'win32', arch: 'x64' })
    expect(result).toMatchObject({ kind: 'valid', manifest: { version: '0.2', channel: 'stable' } })
    // Both hops were followed, in order, and no address outside the chain was contacted.
    expect(transport.asked).toEqual([communityManifestUrl(IDENTITY), VERSIONED_MANIFEST_URL, MANIFEST_ASSET_HOST_URL])
  })

  it('refuses the same chain when its first hop names the installer instead of the manifest', async () => {
    // The versioned manifest address is trusted as the manifest's twin, so the file name in it is
    // part of the decision: a release's installer is not a document this client may start from.
    const transport = transportFor({
      [communityManifestUrl(IDENTITY)]: { kind: 'redirect', status: 302, location: ASSET_URL },
      [ASSET_URL]: { kind: 'body', status: 200, body: chunks(BYTES) },
    })
    expect(await fetchCommunityUpdateManifest(transport, communityManifestUrl(IDENTITY), IDENTITY, { os: 'win32', arch: 'x64' }))
      .toEqual({ kind: 'unreachable', fault: 'redirect-refused' })
    expect(transport.asked).toEqual([communityManifestUrl(IDENTITY)])
  })

  it('refuses a versioned manifest address outside the fork\'s own release tags', async () => {
    for (const tag of ['not-a-community-tag', 'dsh-v0.2.0-rc.2', 'refs/heads/main']) {
      const level = `https://github.com/${IDENTITY.repository}/releases/download/${tag}/${IDENTITY.manifest}`
      const transport = transportFor({
        [communityManifestUrl(IDENTITY)]: { kind: 'redirect', status: 302, location: level },
        [level]: { kind: 'body', status: 200, body: chunks(manifestBody()) },
      })
      expect(await fetchCommunityUpdateManifest(transport, communityManifestUrl(IDENTITY), IDENTITY, { os: 'win32', arch: 'x64' }), tag)
        .toEqual({ kind: 'unreachable', fault: 'redirect-refused' })
      expect(transport.asked).toEqual([communityManifestUrl(IDENTITY)])
    }
  })

  it('refuses a versioned manifest address belonging to another repository', async () => {
    const elsewhere = 'https://github.com/other/repo/releases/download/community-v0.2/latest-community.json'
    const transport = transportFor({
      [communityManifestUrl(IDENTITY)]: { kind: 'redirect', status: 302, location: elsewhere },
      [elsewhere]: { kind: 'body', status: 200, body: chunks(manifestBody()) },
    })
    expect(await fetchCommunityUpdateManifest(transport, communityManifestUrl(IDENTITY), IDENTITY, { os: 'win32', arch: 'x64' }))
      .toEqual({ kind: 'unreachable', fault: 'redirect-refused' })
    expect(transport.asked).toEqual([communityManifestUrl(IDENTITY)])
  })

  it('follows both hops for an installer, and still refuses one that leaves the repository', async () => {
    const transport = transportFor({
      [ASSET_URL]: { kind: 'redirect', status: 302, location: ASSET_HOST_URL },
      [ASSET_HOST_URL]: { kind: 'body', status: 200, body: chunks(BYTES) },
    })
    expect(await downloadCommunityUpdateAsset(transport, IDENTITY, asset(), sink()))
      .toMatchObject({ kind: 'transferred', transfer: { sha256: DIGEST } })
    expect(transport.asked).toEqual([ASSET_URL, ASSET_HOST_URL])
    // The installer's asset address may not be redirected back into a document of the release.
    const back = transportFor({
      [ASSET_URL]: { kind: 'redirect', status: 302, location: VERSIONED_MANIFEST_URL },
      [VERSIONED_MANIFEST_URL]: { kind: 'body', status: 200, body: chunks(manifestBody()) },
    })
    expect(await downloadCommunityUpdateAsset(back, IDENTITY, asset(), sink()))
      .toEqual({ kind: 'failed', fault: 'redirect-refused' })
    expect(back.asked).toEqual([ASSET_URL])
  })
})

/** The repository the shipped identity names, for the refusal cases above. */
describe('downloading an installer', () => {
  it('transfers the bytes, reports their digest, and streams them to the sink once', async () => {
    const destination = sink()
    const progress: number[] = []
    const result = await downloadCommunityUpdateAsset(
      answering({ kind: 'body', status: 200, body: chunks(BYTES.subarray(0, 10), BYTES.subarray(10)) }),
      IDENTITY,
      asset(),
      destination,
      { onProgress: (received) => { progress.push(received) } },
    )
    expect(result).toEqual({ kind: 'transferred', transfer: { sha256: DIGEST, size: BYTES.byteLength } })
    expect(destination.written).toBe(BYTES.byteLength)
    // Progress is cumulative rather than per-chunk, which is what a surface renders.
    expect(progress).toEqual([10, BYTES.byteLength])
  })

  it('refuses bytes whose digest is not the one the release published', async () => {
    // The whole point of the module: every byte arrived, the length matched, and the file is still
    // refused. A version that skipped this check would pass every other case in this file.
    const destination = sink()
    const tampered = Buffer.from(BYTES)
    tampered[0] = 0x62
    const result = await downloadCommunityUpdateAsset(
      answering({ kind: 'body', status: 200, body: chunks(tampered) }),
      IDENTITY,
      asset(),
      destination,
    )
    expect(result).toEqual({ kind: 'failed', fault: 'checksum-mismatch' })
    // The bytes did reach the sink — that is why the caller stages them under a temporary name — and
    // the transfer reports the refusal so the caller discards them rather than promoting them.
    expect(destination.written).toBe(BYTES.byteLength)
  })

  it('refuses a short read as a length failure rather than as a checksum failure', async () => {
    const result = await downloadCommunityUpdateAsset(
      answering({ kind: 'body', status: 200, body: chunks(BYTES.subarray(0, 5)) }),
      IDENTITY,
      asset(),
      sink(),
    )
    // Reporting a truncated transfer as a digest mismatch would hide why the transfer stopped.
    expect(result).toEqual({ kind: 'failed', fault: 'size-mismatch' })
  })

  it('checks nothing about length when the manifest declared none', async () => {
    const result = await downloadCommunityUpdateAsset(
      answering({ kind: 'body', status: 200, body: chunks(BYTES) }),
      IDENTITY,
      { fileName: ASSET_NAME, url: ASSET_URL, sha256: DIGEST },
      sink(),
    )
    expect(result).toMatchObject({ kind: 'transferred', transfer: { sha256: DIGEST } })
  })

  it('reports an aborted or stalled body as a network failure, not as a short file', async () => {
    const url = ASSET_URL
    for (const reply of [
      { kind: 'failure', reason: 'network' } as const,
      { kind: 'failure', reason: 'timeout' } as const,
      { kind: 'body', status: 200, body: failing([BYTES.subarray(0, 4)], new Error('aborted')) } as const,
    ]) {
      const result = await downloadCommunityUpdateAsset(transportFor({ [url]: reply }), IDENTITY, asset(), sink())
      const expected = reply.kind === 'failure' ? reply.reason : 'network'
      expect(result).toEqual({ kind: 'failed', fault: expected })
    }
  })

  it('refuses a response that is not a success, and never reads its body', async () => {
    for (const status of [302, 304, 400, 404, 500]) {
      const result = await downloadCommunityUpdateAsset(
        answering({ kind: 'body', status, body: chunks('error page') }),
        IDENTITY,
        asset(),
        sink(),
      )
      expect(result).toEqual({ kind: 'failed', fault: 'http-status' })
    }
  })

  it('follows the one redirect a release asset really needs', async () => {
    const transport = transportFor({
      [ASSET_URL]: { kind: 'redirect', status: 302, location: ASSET_HOST_URL },
      [ASSET_HOST_URL]: { kind: 'body', status: 200, body: chunks(BYTES) },
    })
    const result = await downloadCommunityUpdateAsset(transport, IDENTITY, asset(), sink())
    expect(result).toMatchObject({ kind: 'transferred', transfer: { sha256: DIGEST } })
    expect(transport.asked).toEqual([ASSET_URL, ASSET_HOST_URL])
  })

  it('resolves a protocol-relative redirect against the address that answered', async () => {
    // GitHub's own redirects are absolute, but a protocol-relative location is a real form and it
    // must resolve to a hop the policy can judge rather than being treated as an unusable URL.
    const relative = `//${COMMUNITY_ASSET_HOSTS[1]}/${IDENTITY.repository}/${ASSET_NAME}`
    const transport = transportFor({
      [ASSET_URL]: { kind: 'redirect', status: 302, location: relative },
      [`https://${COMMUNITY_ASSET_HOSTS[1]}/${IDENTITY.repository}/${ASSET_NAME}`]: { kind: 'body', status: 200, body: chunks(BYTES) },
    })
    expect(await downloadCommunityUpdateAsset(transport, IDENTITY, asset(), sink())).toMatchObject({ kind: 'transferred' })
  })

  it('refuses a relative redirect that would keep the download on the repository host', async () => {
    // A same-host path is not an asset host, so it is refused like any other unapproved hop: the
    // policy admits the content host a release asset is served from, not "anywhere relative".
    const transport = transportFor({
      [ASSET_URL]: { kind: 'redirect', status: 302, location: `/${IDENTITY.repository}/${ASSET_NAME}` },
    })
    expect(await downloadCommunityUpdateAsset(transport, IDENTITY, asset(), sink()))
      .toEqual({ kind: 'failed', fault: 'redirect-refused' })
    expect(transport.asked).toEqual([ASSET_URL])
  })

  it('refuses a redirect that leaves the asset hosts, without following it', async () => {
    const elsewhere = 'https://evil.test/setup.exe'
    const transport = transportFor({
      [ASSET_URL]: { kind: 'redirect', status: 302, location: elsewhere },
      [elsewhere]: { kind: 'body', status: 200, body: chunks(BYTES) },
    })
    expect(await downloadCommunityUpdateAsset(transport, IDENTITY, asset(), sink()))
      .toEqual({ kind: 'failed', fault: 'redirect-refused' })
    // The unapproved host was never contacted, which is the property that matters.
    expect(transport.asked).toEqual([ASSET_URL])
  })

  it('refuses a redirect to plain HTTP, to the repository itself, and to an unusable location', async () => {
    for (const location of [
      ASSET_HOST_URL.replace('https:', 'http:'),
      communityManifestUrl(IDENTITY),
      communityReleasesUrl(IDENTITY),
      'file:///C:/Users/secret/setup.exe',
      '',
    ]) {
      expect(await downloadCommunityUpdateAsset(
        answering({ kind: 'redirect', status: 302, location }),
        IDENTITY,
        asset(),
        sink(),
      ), location).toEqual({ kind: 'failed', fault: 'redirect-refused' })
    }
  })

  it('ends a redirect loop at the cap rather than reading forever', async () => {
    const transport: CommunityUpdateTransport = {
      request: async () => ({ kind: 'redirect', status: 302, location: ASSET_HOST_URL }),
    }
    expect(await downloadCommunityUpdateAsset(transport, IDENTITY, asset(), sink()))
      .toEqual({ kind: 'failed', fault: 'redirect-refused' })
    // The first address plus one hop per cap, and not one more.
    expect(ASSET_HOST_URL).toContain(COMMUNITY_ASSET_HOSTS[0])
    expect(COMMUNITY_UPDATE_MAX_REDIRECTS).toBe(4)
  })

  it('never starts a download at an address the identity does not own', async () => {
    const transport = transportFor({})
    for (const url of [
      ASSET_URL.replace('https:', 'http:'),
      'file:///C:/Users/secret/setup.exe',
      'https://evil.test/setup.exe',
      `https://objects.githubusercontent.com/${IDENTITY.repository}/${ASSET_NAME}`,
      communityReleasesUrl(IDENTITY),
    ]) {
      expect(await downloadCommunityUpdateAsset(transport, IDENTITY, asset({ url }), sink()), url)
        .toEqual({ kind: 'failed', fault: 'redirect-refused' })
    }
    expect(transport.asked).toEqual([])
  })

  it('honours a sink that refuses a chunk by reporting a network failure', async () => {
    const refusing: CommunityUpdateSink = { write: async () => { throw new Error('ENOSPC') } }
    expect(await downloadCommunityUpdateAsset(
      answering({ kind: 'body', status: 200, body: chunks(BYTES) }), IDENTITY, asset(), refusing,
    )).toEqual({ kind: 'failed', fault: 'network' })
  })

  it('passes the declared size to the transport as the byte ceiling it may read', async () => {
    const seen: (number | undefined)[] = []
    const transport: CommunityUpdateTransport = {
      request: async (_url, options) => {
        seen.push(options?.limit)
        return { kind: 'body', status: 200, body: chunks(BYTES) }
      },
    }
    await downloadCommunityUpdateAsset(transport, IDENTITY, asset(), sink())
    expect(seen).toEqual([BYTES.byteLength])
    await downloadCommunityUpdateAsset(transport, IDENTITY, unsized(), sink())
    expect(seen).toEqual([BYTES.byteLength, undefined])
  })

  it('does not report progress for a transfer it refuses', async () => {
    const onProgress = vi.fn()
    await downloadCommunityUpdateAsset(
      answering({ kind: 'failure', reason: 'network' }), IDENTITY, asset(), sink(), { onProgress },
    )
    expect(onProgress).not.toHaveBeenCalled()
  })
})
