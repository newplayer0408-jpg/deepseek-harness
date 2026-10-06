/**
 * Reading a Community update over the network, and proving what arrived is what was published.
 *
 * Two properties decide the shape of this module.
 *
 * The first is that a download is checked, not trusted. A release publishes the SHA-256 of every
 * installer, so the client hashes the bytes as they arrive and refuses the file unless the digest
 * matches and, when the manifest declared one, the length matches too. Nothing is written to its
 * final name before both checks pass, which is what makes a failed download leave no file a user
 * could be tempted to run.
 *
 * The second is that redirects are a policy rather than a setting. A release asset is served from
 * GitHub's content host after a redirect, so following none would break every real download; and
 * following any would let the host decide where this installation fetches an installer from. So each
 * hop is resolved against the current URL and checked against {@link communityRedirectAllowed}, which
 * admits only the repository's own release path and GitHub's asset hosts — and the chain is capped,
 * so a redirect loop ends as a refusal rather than as an endless read.
 *
 * The network itself arrives through {@link CommunityUpdateTransport}, because that is what makes
 * every rule above testable without a socket. The real transport lives beside the shell's own
 * Electron wiring; nothing here imports Electron, the filesystem, or the clock.
 */

import { createHash } from 'node:crypto'
import {
  communityRedirectAllowed,
  communityReleaseOrigin,
  type CommunityReleaseIdentity,
} from './community-release.ts'
import {
  COMMUNITY_UPDATE_MAX_MANIFEST_BYTES,
  parseCommunityUpdateManifest,
  type CommunityUpdateAsset,
  type CommunityUpdateManifestResult,
} from './community-update-manifest.ts'

/**
 * How many redirects one request may follow.
 *
 * GitHub needs one hop from the release path to its asset host, and the internal moves it performs
 * add at most one more. A larger number would only give a misconfigured or hostile endpoint more
 * room, so the cap is stated rather than left to the transport.
 */
export const COMMUNITY_UPDATE_MAX_REDIRECTS = 4

/** Why a transfer could not produce a verified result. */
export type CommunityUpdateTransferFault =
  /** No connection, a DNS failure, a reset, or another transport-level failure. */
  | 'network'
  /** The connection went silent past the transport's idle deadline. */
  | 'timeout'
  /** The response asked to go somewhere this installation will not follow. */
  | 'redirect-refused'
  /** The response was not a success and was not a redirect. */
  | 'http-status'
  /** The body exceeded the bound the request set. */
  | 'too-large'
  /** The received length differs from the length the manifest declared. */
  | 'size-mismatch'
  /** The received bytes do not hash to the manifest's digest. */
  | 'checksum-mismatch'

/** One settled HTTP exchange, already reduced to what a caller may act on. */
export type CommunityUpdateReply =
  | {
    readonly kind: 'body'
    readonly status: number
    readonly body: AsyncIterable<Uint8Array>
    /** `content-length` as a number, when the response declared a usable one. */
    readonly contentLength?: number
  }
  | { readonly kind: 'redirect'; readonly status: number; readonly location: string }
  | { readonly kind: 'failure'; readonly reason: 'network' | 'timeout' }

/**
 * One HTTP GET, without redirect following.
 *
 * The transport must not follow redirects itself: a redirect is answered as {@link CommunityUpdateReply}
 * so the policy above can judge each hop. It must not throw for a connection failure either — a
 * rejection is reserved for a programming error, because every expected failure has a reason.
 */
export interface CommunityUpdateTransport {
  /**
   * @param url - absolute HTTPS URL to read.
   * @param options - optional byte ceiling for the body.
   * @returns the settled exchange; the caller consumes `body` and owns closing it.
   */
  request(url: string, options?: { readonly limit?: number }): Promise<CommunityUpdateReply>
}

/** Where verified bytes are handed on their way to disk. */
export interface CommunityUpdateSink {
  /**
   * Accept one chunk of the download.
   *
   * A rejection aborts the transfer, which is how a full disk or a refused directory becomes a
   * reported state instead of a partial file left in place.
   * @param chunk - the next bytes of the body.
   */
  write(chunk: Uint8Array): Promise<void>
}

/** The digest of one transferred body. */
export interface CommunityUpdateTransfer {
  /** Lowercase hexadecimal SHA-256 of every byte handed to the sink. */
  readonly sha256: string
  /** Number of bytes transferred. */
  readonly size: number
}

/** The outcome of one transfer. */
export type CommunityUpdateTransferResult =
  | { readonly kind: 'transferred'; readonly transfer: CommunityUpdateTransfer }
  | { readonly kind: 'failed'; readonly fault: CommunityUpdateTransferFault }

/** The outcome of reading and validating one manifest. */
export type CommunityUpdateManifestFetch =
  | CommunityUpdateManifestResult
  | { readonly kind: 'unreachable'; readonly fault: CommunityUpdateTransferFault }

/**
 * Read the manifest for one release identity.
 *
 * The body is bounded before it is parsed, and a response that is not a success is reported as a
 * refusal rather than parsed for an error message — a manifest host's error page is not a document a
 * client may read anything from. A transfer that never delivered a body stays distinct from a body
 * that failed validation, because the two are different things to tell a user: one is a network
 * problem to retry, the other is a release file nobody should act on.
 * @param transport - the HTTP seam.
 * @param url - manifest URL, as {@link communityManifestUrl} builds it.
 * @param identity - the fork's release identity the URL must belong to.
 * @param platform - the running platform and architecture.
 * @returns the validated manifest, the reason it was refused, or the transfer fault that stopped it.
 */
export async function fetchCommunityUpdateManifest(
  transport: CommunityUpdateTransport,
  url: string,
  identity: CommunityReleaseIdentity,
  platform: { readonly os: string; readonly arch: string },
): Promise<CommunityUpdateManifestFetch> {
  const reply = await openCommunityResponse(transport, url, identity, COMMUNITY_UPDATE_MAX_MANIFEST_BYTES)
  if (reply.kind === 'failed') return { kind: 'unreachable', fault: reply.fault }
  let received = 0
  const chunks: Uint8Array[] = []
  try {
    for await (const chunk of reply.body) {
      received += chunk.byteLength
      if (received > COMMUNITY_UPDATE_MAX_MANIFEST_BYTES) return { kind: 'unreachable', fault: 'too-large' }
      chunks.push(chunk)
    }
  } catch {
    return { kind: 'unreachable', fault: 'network' }
  }
  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
  return parseCommunityUpdateManifest(body, identity, platform)
}

/**
 * Download one installer and prove it is the published one.
 *
 * Bytes reach the sink as they arrive, so a large installer is never held in memory, and the digest
 * is computed in the same pass. A length the manifest declared is checked before the digest, because
 * a short read is the more specific fault and reporting it as a checksum failure would hide why the
 * transfer stopped.
 * @param transport - the HTTP seam.
 * @param identity - the fork's release identity the asset URL must belong to.
 * @param asset - the installer entry the manifest published.
 * @param sink - where the bytes are handed.
 * @param options - optional progress callback, invoked with the byte count so far.
 * @returns the digest and length of a verified transfer, or the fault that refused it.
 */
export async function downloadCommunityUpdateAsset(
  transport: CommunityUpdateTransport,
  identity: CommunityReleaseIdentity,
  asset: CommunityUpdateAsset,
  sink: CommunityUpdateSink,
  options: { readonly onProgress?: (received: number) => void } = {},
): Promise<CommunityUpdateTransferResult> {
  const reply = await openCommunityResponse(transport, asset.url, identity, asset.size)
  if (reply.kind === 'failed') return { kind: 'failed', fault: reply.fault }
  const hash = createHash('sha256')
  let size = 0
  try {
    for await (const chunk of reply.body) {
      hash.update(chunk)
      size += chunk.byteLength
      await sink.write(chunk)
      options.onProgress?.(size)
    }
  } catch {
    return { kind: 'failed', fault: 'network' }
  }
  if (asset.size !== undefined && size !== asset.size) return { kind: 'failed', fault: 'size-mismatch' }
  const sha256 = hash.digest('hex')
  if (sha256 !== asset.sha256) return { kind: 'failed', fault: 'checksum-mismatch' }
  return { kind: 'transferred', transfer: { sha256, size } }
}

/** The body of one accepted response, or the fault that refused it. */
type OpenResponseResult =
  | { readonly kind: 'body'; readonly body: AsyncIterable<Uint8Array> }
  | { readonly kind: 'failed'; readonly fault: CommunityUpdateTransferFault }

/**
 * Follow one URL to an accepted response, checking the origin of every hop.
 *
 * The first URL is checked as strictly as any redirect target: a caller is trusted because it built
 * the URL from the same identity this function is given, but checking it here means the guarantee
 * holds even if a future caller passes a URL from somewhere else.
 * @param transport - the HTTP seam.
 * @param url - the absolute HTTPS URL to read.
 * @param identity - the fork's release identity.
 * @param limit - optional byte ceiling for the body.
 * @returns the accepted body, or the fault that refused the exchange.
 */
async function openCommunityResponse(
  transport: CommunityUpdateTransport,
  url: string,
  identity: CommunityReleaseIdentity,
  limit: number | undefined,
): Promise<OpenResponseResult> {
  const origin = communityReleaseOrigin(url, identity)
  if (origin !== 'manifest' && origin !== 'asset') return { kind: 'failed', fault: 'redirect-refused' }
  let current = url
  for (let hop = 0; hop <= COMMUNITY_UPDATE_MAX_REDIRECTS; hop += 1) {
    const reply = await requestOrFail(transport, current, limit)
    if (reply.kind === 'failure') return { kind: 'failed', fault: reply.reason }
    if (reply.kind === 'body') {
      if (reply.status < 200 || reply.status > 299) return { kind: 'failed', fault: 'http-status' }
      return { kind: 'body', body: reply.body }
    }
    if (hop === COMMUNITY_UPDATE_MAX_REDIRECTS) return { kind: 'failed', fault: 'redirect-refused' }
    const target = resolveRedirect(reply.location, current)
    if (target === undefined || !communityRedirectAllowed(current, target, identity)) {
      return { kind: 'failed', fault: 'redirect-refused' }
    }
    current = target
  }
  return { kind: 'failed', fault: 'redirect-refused' }
}

/** Perform one request, turning a rejection into a reported transport failure. */
async function requestOrFail(
  transport: CommunityUpdateTransport,
  url: string,
  limit: number | undefined,
): Promise<CommunityUpdateReply> {
  try {
    return await transport.request(url, limit === undefined ? undefined : { limit })
  } catch {
    return { kind: 'failure', reason: 'network' }
  }
}

/**
 * Resolve one `location` against the URL that answered with it.
 * @param location - the raw header value.
 * @param base - the URL that answered.
 * @returns the absolute target, or undefined when it is not a usable URL.
 */
function resolveRedirect(location: string, base: string): string | undefined {
  try {
    return new URL(location, base).href
  } catch {
    return undefined
  }
}
