/**
 * The Community update state machine: one installation's own update story, from asking to having a
 * verified installer on disk.
 *
 * This module owns every decision between "ask the release repository" and "hand the user a file it
 * may run", and it owns them as a single sequence so no other layer has to re-derive what is
 * currently true. It reads no Electron API, no environment, and no file of its own: the network is a
 * {@link CommunityUpdateTransport}, the disk is a {@link CommunityUpdateStore}, and the version facts
 * arrive as data. A unit test can therefore drive every phase — including the failure phases, which
 * are the ones that matter — without a socket or a filesystem.
 *
 * Three rules are worth stating because they are what the code below is arranged around.
 *
 * - **Nothing is offered before it is compared.** A manifest is only ever an available update when
 *   {@link isCommunityUpdateAvailable} says so, which keeps a stable installation from being offered
 *   a prerelease and a development installation from being silently replaced by a release.
 * - **A failed download leaves nothing behind.** The store stages bytes under a temporary name, and
 *   a checksum or length failure discards that file rather than promoting it, so a refused download
 *   cannot become a file a user runs by hand.
 * - **A phase change always carries a phase.** Every early return below names the state it leaves the
 *   service in, so an unexpected answer from any seam is a reported condition rather than a stuck
 *   surface.
 */

import type { CommunityVersionIdentity } from './community-version.ts'
import { communityUpdateChannel, isCommunityUpdateAvailable, type CommunityUpdateChannel } from './community-update.ts'
import {
  communityManifestUrl,
  type CommunityReleaseIdentity,
} from './community-release.ts'
import {
  fetchCommunityUpdateManifest,
  downloadCommunityUpdateAsset,
  type CommunityUpdateSink,
  type CommunityUpdateTransferFault,
  type CommunityUpdateTransport,
} from './community-update-download.ts'
import type { CommunityUpdateManifest, CommunityUpdateManifestFault } from './community-update-manifest.ts'

/**
 * Every state the Community update surface can be in.
 *
 * The set is the one the release flow needs end to end: asking, comparing, transferring, proving, and
 * the four ways each of those can end badly. Naming them here — rather than letting a UI invent
 * wording per outcome — is what keeps a failure the user sees tied to the step that failed.
 */
export type CommunityUpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'update-available'
  | 'downloading'
  | 'downloaded'
  | 'verifying'
  | 'ready'
  | 'network-error'
  | 'invalid-manifest'
  | 'download-error'
  | 'checksum-error'
  | 'unsupported-platform'

/**
 * Stable code for the condition a state reports.
 *
 * A code names a condition, never a message: a transport or a manifest can carry text, and a code is
 * what keeps that text out of the surface and out of a shared diagnostics report.
 */
export type CommunityUpdateFault =
  | 'no-source'
  | 'no-version'
  | CommunityUpdateManifestFault
  | CommunityUpdateTransferFault

/** What one download has transferred so far. */
export interface CommunityUpdateProgress {
  /** Bytes written to the staging file. */
  readonly received: number
  /** Declared total, when the manifest recorded one. */
  readonly total?: number
  /** Whole-percent progress, when the total is known. */
  readonly percent?: number
  /** File name the installer will take once it is verified. */
  readonly fileName: string
  /**
   * Directory the file is staged in, in the symbolic form the shell already uses for a user's own
   * paths. It is a display value: the absolute path never leaves the main process.
   */
  readonly directory: string
}

/**
 * Everything the update surface may display.
 *
 * Each field is either a fact read from a validated manifest or a value the shell resolved itself, so
 * the presentation layer formats a state it cannot widen.
 */
export interface CommunityUpdateState {
  readonly phase: CommunityUpdatePhase
  /** Community version this installation reports, such as `v0.2-dev`; empty when it declared none. */
  readonly currentVersion: string
  /** Channel this installation follows, or `unknown` when it declared no version at all. */
  readonly channel: CommunityUpdateChannel | 'unknown'
  /** Release repository in `owner/repo` form; empty when this build declared no release source. */
  readonly source: string
  /** Version the last successful check read, in the user-facing `v` form. */
  readonly latestVersion?: string
  /** Upstream tag the offered release was synced to. Displayed as a fact, never compared. */
  readonly upstreamBase?: string
  /** Publication time the offered release declared. */
  readonly publishedAt?: string
  /** Release page for the offered release. */
  readonly releaseNotesUrl?: string
  /** Schema version of the manifest the last successful check read. */
  readonly manifestSchema?: number
  /** Transfer progress, present only while a download is in flight. */
  readonly progress?: CommunityUpdateProgress
  /** Digest a verified download hashes to; present only once a file is ready. */
  readonly verifiedSha256?: string
  /** Stable code for the condition this state reports, when one applies. */
  readonly fault?: CommunityUpdateFault
}

/** A staged download: the bytes' destination, plus the way to promote or drop them. */
export interface CommunityUpdateStagedFile extends CommunityUpdateSink {
  /** File name the installer will take once verified. */
  readonly fileName: string
  /** Symbolic directory the file is staged in. */
  readonly directory: string
  /**
   * Promote the staged bytes to the verified file, replacing an earlier verified download.
   * @returns the stored file, as the surface reports it.
   */
  commit(): Promise<CommunityUpdateStoredFile>
}

/** A download that passed verification and is on disk. */
export interface CommunityUpdateStoredFile {
  /** File name on disk. */
  readonly fileName: string
  /** Symbolic directory holding it. */
  readonly directory: string
  /** Size in bytes, as transferred. */
  readonly size: number
}

/**
 * Where a download is staged and kept.
 *
 * The store owns every path decision, so the service never composes one and the shell keeps its own
 * notion of where a Community installation stores things. All three operations must be safe to call
 * when nothing is staged: a failed check and a discarded download both leave the store empty.
 */
export interface CommunityUpdateStore {
  /**
   * Begin a fresh download, removing any earlier staged or verified file.
   * @param fileName - installer file name the manifest declared.
   * @returns the staging destination.
   */
  stage(fileName: string): Promise<CommunityUpdateStagedFile>
  /** Remove the staged file and any earlier verified download. */
  discard(): Promise<void>
  /**
   * The file a previous run verified, when it is still on disk.
   * @returns the stored file, or undefined when there is none.
   */
  stored(): Promise<CommunityUpdateStoredFile | undefined>
}

/** Everything the service needs from its owner. */
export interface CommunityUpdateServiceOptions {
  /** The fork's release identity, or undefined on a build whose release source could not be read. */
  readonly identity: CommunityReleaseIdentity | undefined
  /** The version facts this installation reports, or undefined when it declared none. */
  readonly community: CommunityVersionIdentity | undefined
  /** Platform and architecture the manifest is read for. */
  readonly platform: { readonly os: string; readonly arch: string }
  /** HTTP seam. */
  readonly transport: CommunityUpdateTransport
  /** Staging and storage seam. */
  readonly store: CommunityUpdateStore
  /**
   * Called after every state change, including the intermediate phases a download passes through.
   * @param state - the state now in effect.
   */
  readonly onChange?: (state: CommunityUpdateState) => void
}

/**
 * One installation's Community update flow.
 *
 * A check and a download each run at most once at a time: a second request while one is in flight is
 * answered with the state already in effect rather than starting a second transfer, which is what
 * keeps two downloads from writing the same staging file.
 */
export class CommunityUpdateService {
  private current: CommunityUpdateState
  private manifest: CommunityUpdateManifest | undefined
  private running: Promise<CommunityUpdateState> | undefined
  private stored: CommunityUpdateStoredFile | undefined

  /**
   * @param options - the injected release identity, version facts, platform, and seams.
   */
  constructor(private readonly options: CommunityUpdateServiceOptions) {
    const fault: CommunityUpdateFault | undefined = options.identity === undefined
      ? 'no-source'
      : options.community === undefined ? 'no-version' : undefined
    this.current = {
      phase: 'idle',
      currentVersion: options.community?.version ?? '',
      channel: communityUpdateChannel(options.community) ?? 'unknown',
      source: options.identity?.repository ?? '',
      ...fault === undefined ? {} : { fault },
    }
  }

  /** The state in effect. */
  state(): CommunityUpdateState { return this.current }

  /**
   * The verified installer a previous or current download produced.
   * @returns the stored file, or undefined when none is present.
   */
  storedFile(): CommunityUpdateStoredFile | undefined { return this.stored }

  /**
   * Ask the release repository whether a newer Community version exists.
   *
   * The comparison is against the version this installation reports, and the manifest is kept only
   * while it is still the newest answer: a later check that finds nothing new clears it, so a stale
   * manifest can never be downloaded behind a newer check's result.
   * @returns the state after the check.
   */
  async check(): Promise<CommunityUpdateState> {
    return await this.serial(async () => await this.runCheck())
  }

  /**
   * Download the installer the last check offered, and verify it before it is promoted.
   *
   * A download is refused unless a check is currently offering one, so the surface cannot start a
   * transfer against a manifest that was never compared with this build.
   * @returns the state after the download.
   */
  async download(): Promise<CommunityUpdateState> {
    return await this.serial(async () => await this.runDownload())
  }

  /** Drop any subscription the owner installed; the service keeps no other resource. */
  dispose(): void { this.running = undefined }

  /** Run one operation, sharing an in-flight one with every caller while it lasts. */
  private async serial(operation: () => Promise<CommunityUpdateState>): Promise<CommunityUpdateState> {
    this.running ??= operation().finally(() => { this.running = undefined })
    return await this.running
  }

  /** Move to a new state and tell the owner. */
  private publish(next: CommunityUpdateState): CommunityUpdateState {
    this.current = next
    this.options.onChange?.(next)
    return next
  }

  /** The state fields that describe this installation rather than one release. */
  private base(): Pick<CommunityUpdateState, 'currentVersion' | 'channel' | 'source'> {
    return {
      currentVersion: this.options.community?.version ?? '',
      channel: communityUpdateChannel(this.options.community) ?? 'unknown',
      source: this.options.identity?.repository ?? '',
    }
  }

  /** Read and compare the manifest. */
  private async runCheck(): Promise<CommunityUpdateState> {
    const identity = this.options.identity
    if (identity === undefined) return this.publish({ ...this.base(), phase: 'idle', fault: 'no-source' })
    this.manifest = undefined
    this.publish({ ...this.base(), phase: 'checking' })
    const url = communityManifestUrl(identity)
    const answer = await fetchCommunityUpdateManifest(this.options.transport, url, identity, this.options.platform)
    if (answer.kind === 'unreachable') {
      return this.publish({ ...this.base(), phase: 'network-error', fault: answer.fault })
    }
    if (answer.kind === 'invalid') {
      const phase = answer.fault === 'unsupported-platform' ? 'unsupported-platform' : 'invalid-manifest'
      return this.publish({ ...this.base(), phase, fault: answer.fault })
    }
    const manifest = answer.manifest
    const release = {
      latestVersion: `v${manifest.version}`,
      manifestSchema: manifest.schemaVersion,
      publishedAt: manifest.publishedAt,
      ...manifest.upstreamBase === undefined ? {} : { upstreamBase: manifest.upstreamBase },
      ...manifest.releaseNotesUrl === undefined ? {} : { releaseNotesUrl: manifest.releaseNotesUrl },
    }
    const local = this.options.community?.version
    if (local === undefined || !isCommunityUpdateAvailable(local, manifest.version)) {
      this.manifest = undefined
      return this.publish({ ...this.base(), ...release, phase: 'up-to-date' })
    }
    this.manifest = manifest
    return this.publish({ ...this.base(), ...release, phase: 'update-available' })
  }

  /** Transfer, verify, and promote the offered installer. */
  private async runDownload(): Promise<CommunityUpdateState> {
    const identity = this.options.identity
    const manifest = this.manifest
    const base = this.base()
    if (identity === undefined) return this.publish({ ...base, phase: 'idle', fault: 'no-source' })
    if (manifest === undefined) return this.publish({ ...base, phase: 'idle', fault: 'no-version' })
    const asset = manifest.asset
    const offered: CommunityUpdateState = {
      ...base,
      phase: 'downloading',
      latestVersion: `v${manifest.version}`,
      manifestSchema: manifest.schemaVersion,
      ...manifest.upstreamBase === undefined ? {} : { upstreamBase: manifest.upstreamBase },
      ...manifest.releaseNotesUrl === undefined ? {} : { releaseNotesUrl: manifest.releaseNotesUrl },
      publishedAt: manifest.publishedAt,
    }
    let staged: CommunityUpdateStagedFile
    try {
      staged = await this.options.store.stage(asset.fileName)
    } catch {
      return this.publish({ ...offered, phase: 'download-error', fault: 'network' })
    }
    const directory = staged.directory
    const progress = (received: number): void => {
      this.publish({
        ...offered,
        phase: 'downloading',
        progress: {
          received,
          fileName: asset.fileName,
          directory,
          ...asset.size === undefined ? {} : {
            total: asset.size,
            percent: Math.min(100, Math.floor((received / asset.size) * 100)),
          },
        },
      })
    }
    const transfer = await downloadCommunityUpdateAsset(this.options.transport, identity, asset, staged, {
      onProgress: (received) => { progress(received) },
    })
    if (transfer.kind === 'failed') {
      await this.discardStaging()
      return this.publish({ ...offered, phase: this.failurePhase(transfer.fault), fault: transfer.fault })
    }
    this.publish({ ...offered, phase: 'verifying' })
    let file: CommunityUpdateStoredFile
    try {
      file = await staged.commit()
    } catch {
      await this.discardStaging()
      return this.publish({ ...offered, phase: 'download-error', fault: 'network' })
    }
    this.stored = file
    const size = transfer.transfer.size
    const ready: CommunityUpdateState = {
      ...offered,
      phase: 'downloaded',
      verifiedSha256: transfer.transfer.sha256,
      progress: { received: size, total: size, percent: 100, fileName: file.fileName, directory: file.directory },
    }
    this.publish(ready)
    return this.publish({ ...ready, phase: 'ready' })
  }

  /** Discard a staged or stored file, turning a storage failure into nothing to promote. */
  private async discardStaging(): Promise<void> {
    this.stored = undefined
    try {
      await this.options.store.discard()
    } catch { /* A store that cannot be cleaned holds nothing a user may run. */ }
  }

  /** The phase one transfer fault reports. */
  private failurePhase(fault: CommunityUpdateTransferFault): CommunityUpdatePhase {
    if (fault === 'checksum-mismatch') return 'checksum-error'
    if (fault === 'network' || fault === 'timeout') return 'network-error'
    return 'download-error'
  }
}
