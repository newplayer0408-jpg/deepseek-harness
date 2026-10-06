/**
 * Community Diagnostics: the probe engine and the deterministic report renderer.
 *
 * Phase 1 ships logic only. The engine is a function of injected seams, so it reads no Electron API,
 * no shell module, and no file of its own; a unit test can therefore drive every state without
 * touching the machine that runs it. The diagnostics window, its isolated preload, and the
 * main-process wiring arrive in later phases and supply the real seams for the same collector.
 *
 * The security model is a division of labour, and it is worth stating what each part does and does
 * not do:
 *
 * 1. A secret is never read on purpose. A provider is reported as a count rather than as content, a
 *    credential file is never opened, and the environment is classified instead of printed.
 * 2. {@link collectCommunityDiagnostics} reduces each seam's answer to a public view, so a probe
 *    target and a raw error become a stable code instead of text.
 * 3. Each field the collector does render passes a gate for the shape its real source produces (see
 *    {@link SAFE_VERSION} and its neighbours), so an answer outside that shape renders as a
 *    placeholder rather than as its own text.
 * 4. {@link renderCommunityDiagnosticsReport} is a pure formatter for that view. It re-derives
 *    nothing and sanitizes nothing — it trusts the view's types — so a view assembled by hand sits
 *    outside the contract, and step 3 is what keeps a hostile seam out of a report.
 * 5. Together, 1–4 are why no raw exception message, probe path, or credential value reaches the
 *    shareable text.
 *
 * A second property decides the rest of the shape: a diagnostic has to survive the failure it exists
 * to explain. Every probe runs through {@link attempt} or {@link attemptAsync}, so an absent file, a
 * backend that never became ready, or a seam that throws becomes a check state instead of an
 * exception from the collector.
 */

import {
  DEFAULT_DSH_COMMUNITY_HOME_DISPLAY,
  DEFAULT_DSH_DEV_HOME_DISPLAY,
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_ENV,
} from '@deepseek-ai/dsh-home-paths'
import { DESKTOP_COMMUNITY_VARIANT, type DesktopVariant } from './desktop-variant.ts'

/**
 * Report format version; bumped only when the field set or a line syntax changes.
 *
 * Version 2 appended the three version checks — `community-version`, `upstream-base`, and
 * `upstream-commit` — so one installation now reports a different set of lines than version 1
 * produced. No header field, no line syntax, and no earlier check changed with it.
 *
 * Version 3 appended the seven read-only update checks, which describe the Community update surface
 * rather than the installation: where updates are read from, which channel is followed, what the last
 * check found, which version it offered, which manifest schema it was written in, whether an
 * installer is on disk, and whether its digest was verified. They are appended for the same reason
 * version 2's were, and no earlier line moved.
 */
export const COMMUNITY_DIAGNOSTICS_REPORT_VERSION = 3

/** Placeholder for a fact the collector could not read. */
const UNKNOWN = 'unknown'

/** Value a build that is not the community variant reports for a fact only a community build declares. */
const NOT_COMMUNITY = 'not a community build'

/**
 * Check ids in report order.
 *
 * The order is part of the contract: two reports of the same installation must diff cleanly, so a
 * new check is appended rather than inserted, and the renderer never reorders what it is given. The
 * three version checks at the end are the rule's current example: they were appended together, so
 * every line an earlier report printed kept its position.
 */
export const COMMUNITY_DIAGNOSTIC_IDS = [
  'community-edition',
  'application-version',
  'data-directory',
  'packaged-runtime',
  'packaged-files',
  'backend',
  'provider-configuration',
  'model-configuration',
  'updates',
  'telemetry',
  'system',
  'community-version',
  'upstream-base',
  'upstream-commit',
  'community-update-source',
  'community-update-channel',
  'community-update-last-check',
  'community-update-latest',
  'community-update-manifest',
  'community-update-download',
  'community-update-checksum',
] as const

/** Stable identifier of one diagnostic check. */
export type CommunityDiagnosticId = typeof COMMUNITY_DIAGNOSTIC_IDS[number]

/** The four states a check can report. */
export type CommunityDiagnosticsState = 'PASS' | 'WARN' | 'FAIL' | 'INFO'

/**
 * Stable machine-readable codes attached to a non-pass check.
 *
 * A code names a condition, never a message: an exception message can embed a path, a command line,
 * or a credential, so it never reaches a shareable report.
 */
export const COMMUNITY_DIAGNOSTIC_CODES = {
  /** A build that does not declare the community variant. */
  variantNotCommunity: 'E-VARIANT-NOT-COMMUNITY',
  /** The application reported no version. */
  applicationVersionMissing: 'E-APPLICATION-VERSION-MISSING',
  /** The Harness home exists but is not a directory. */
  homeNotDirectory: 'E-DATA-HOME-NOT-DIRECTORY',
  /** The Harness home is a directory that refused a write probe. */
  homeNotWritable: 'E-DATA-HOME-NOT-WRITABLE',
  /** The Harness home could not be inspected at all, so its existence and type are unknown. */
  homeProbe: 'E-DATA-HOME-PROBE',
  /** The Harness home is a directory, but the write probe itself failed to reach a verdict. */
  homeWriteProbe: 'E-DATA-HOME-WRITE-PROBE',
  /** The packaged runtime descriptor is absent. */
  runtimeDescriptorMissing: 'E-RUNTIME-DESCRIPTOR-MISSING',
  /** The descriptor is unreadable, is not a file, or reported a version outside the safe shape. */
  runtimeDescriptorInvalid: 'E-RUNTIME-DESCRIPTOR-INVALID',
  /** The packaged runtime descriptor reads, but the immutable primary runtime is absent. */
  runtimePrimaryMissing: 'E-RUNTIME-PRIMARY-MISSING',
  /** The immutable primary runtime is not a directory, or could not be probed at all. */
  runtimePrimaryInvalid: 'E-RUNTIME-PRIMARY-INVALID',
  /** One or more files a working installation must ship are absent. */
  packagedFileMissing: 'E-PACKAGED-FILE-MISSING',
  /** A required packaged entry is present as the wrong kind of entry. */
  packagedFileKind: 'E-PACKAGED-FILE-KIND',
  /** A required packaged entry could not be probed, so its presence is unknown. */
  packagedFileProbe: 'E-PACKAGED-FILE-PROBE',
  /** The backend has not finished starting, so no fact behind it can be read yet. */
  backendNotReady: 'E-BACKEND-NOT-READY',
  /** The backend reported a startup or runtime failure. */
  backendError: 'E-BACKEND-ERROR',
  /** A backend round-trip produced no answer. */
  backendRpc: 'E-BACKEND-RPC',
  /** The backend reported ready, but no round-trip independently confirmed it. */
  backendNotVerified: 'E-BACKEND-NOT-VERIFIED',
  /** The runtime offers no configurable provider at all. */
  providerNoneAvailable: 'E-PROVIDER-NONE-AVAILABLE',
  /** Providers are available but none holds a configuration. */
  providerNoneConfigured: 'E-PROVIDER-NONE-CONFIGURED',
  /** No model configuration is present. */
  modelNotConfigured: 'E-MODEL-NOT-CONFIGURED',
  /** A community build unexpectedly carries an official update mechanism. */
  updatesNotCommunityManaged: 'E-UPDATES-NOT-COMMUNITY-MANAGED',
  /** Session-log telemetry is set to a mode other than the community default. */
  telemetryOverridden: 'E-TELEMETRY-OVERRIDDEN',
  /** No session-log telemetry mode is set at all, which no community build expects. */
  telemetryUnknown: 'E-TELEMETRY-UNKNOWN',
  /** A community build declared no community version this installation could read. */
  communityVersionMissing: 'E-COMMUNITY-VERSION-MISSING',
  /** A community build declared no upstream base this installation could read. */
  upstreamBaseMissing: 'E-UPSTREAM-BASE-MISSING',
  /** A community build declared no upstream commit this installation could read. */
  upstreamCommitMissing: 'E-UPSTREAM-COMMIT-MISSING',
  /** A community build declared no release repository, so it has nowhere to read updates from. */
  updateSourceMissing: 'E-UPDATE-SOURCE-MISSING',
  /** The last update check failed for a reason the update service reported. */
  updateLastCheckFailed: 'E-UPDATE-LAST-CHECK-FAILED',
  /** A downloaded update file is present but its digest was not verified. */
  updateNotVerified: 'E-UPDATE-NOT-VERIFIED',
  /** A downloaded update file failed its digest check. */
  updateChecksumFailed: 'E-UPDATE-CHECKSUM-FAILED',
  /** This platform has no published Community installer. */
  updateUnsupportedPlatform: 'E-UPDATE-UNSUPPORTED-PLATFORM',
} as const

/** One stable code from {@link COMMUNITY_DIAGNOSTIC_CODES}. */
export type CommunityDiagnosticCode = typeof COMMUNITY_DIAGNOSTIC_CODES[keyof typeof COMMUNITY_DIAGNOSTIC_CODES]

/**
 * What one entry probe found.
 *
 * `absent` and `unreadable` are outcomes rather than entry kinds, and keeping them apart is the
 * point: a path that is not there and a probe that could not answer are different facts, and an
 * engine that collapsed both onto one empty value would report a permissions failure as a benign
 * first run.
 */
export type CommunityDiagnosticsEntry = 'file' | 'directory' | 'other' | 'absent' | 'unreadable'

/** Filesystem probes the collector performs. */
export interface CommunityDiagnosticsFs {
  /**
   * Report what is at one path.
   *
   * A probe that cannot answer must say `unreadable` rather than throw or claim `absent`, so one
   * call site cannot mistake a failure for a missing directory.
   * @param path - absolute path to probe.
   * @returns the entry kind, `absent` when nothing is there, or `unreadable` when the probe failed.
   */
  kind(path: string): CommunityDiagnosticsEntry
  /**
   * Create-then-delete write probe for one directory.
   *
   * A permission bit or `access(W_OK)` consults no ACL on Windows, so the only reliable signal is a
   * real write. The implementation must create a uniquely named file inside `directory`, remove it
   * again, and report only the outcome — never the path it used, an errno, or a reason. It answers
   * `false` for a directory that refused the write; throwing is reserved for a probe that could not
   * reach a verdict, which the collector reports as unverified rather than as not writable.
   * @param directory - absolute directory to probe.
   * @returns whether a uniquely named probe file could be created and removed.
   */
  probeWritableDirectory(directory: string): Promise<boolean>
}

/** The bundled runtime the shell discovered, as probe paths plus one safe read. */
export interface CommunityDiagnosticsRuntime {
  /** Absolute path of the runtime descriptor, which must be a file; probed, never rendered. */
  readonly descriptor: string
  /**
   * Absolute path of the immutable primary runtime, which must be a directory; never rendered.
   *
   * Required rather than optional: every packaged Community runtime ships a primary tree, so a seam
   * that could leave this out would let an installation with no runtime at all still report a
   * passing runtime. The collector therefore treats the primary tree as part of the descriptor
   * contract and inspects it unconditionally.
   */
  readonly primary: string
  /**
   * Read the bundled release version through the shell's own current-state reader.
   *
   * It must answer `undefined` rather than throw when the descriptor is absent, corrupt, or built for
   * another platform, so an unusable runtime degrades into a check state. Whatever it answers is
   * treated as untrusted text: a value outside the safe version shape is discarded rather than
   * rendered, exactly like any other fact from a seam.
   * @returns the bundled dsh version, or undefined when it cannot be read.
   */
  readonly read: () => Promise<string | undefined>
}

/** One file a working installation must ship. */
export interface CommunityDiagnosticsFile {
  /**
   * Label the report renders in place of the probed path: a slash-free, colon-free identifier such as
   * `runtime-bin` or `host-entry`. Anything else renders as `unnamed`, so a label can never smuggle a
   * path fragment into a report.
   */
  readonly label: string
  /** Absolute path probed on disk; never rendered. */
  readonly path: string
  /**
   * Entry kind a working installation must have at that path.
   *
   * A directory sitting where a file belongs makes a build just as broken as an absent entry, so the
   * check compares the probed kind instead of settling for presence.
   */
  readonly kind: 'file' | 'directory'
}

/** Packaged resources the collector probes. */
export interface CommunityDiagnosticsResources {
  readonly runtime: CommunityDiagnosticsRuntime
  readonly files: readonly CommunityDiagnosticsFile[]
}

/** Backend availability plus the optional round-trip probe that proves the child still answers. */
export interface CommunityDiagnosticsBackend {
  readonly phase: 'starting' | 'ready' | 'error'
  /**
   * One bounded round-trip against the running Host.
   *
   * Called only while the phase is ready. Supply a plain function, not a bound method. A missing
   * probe, a rejecting probe, and an answering probe each stay a reported state.
   * @returns whether the Host answered.
   */
  readonly probe?: () => Promise<boolean>
}

/** Provider presence counts; never provider content. */
export interface CommunityDiagnosticsProviders {
  /** Providers the runtime can configure. */
  readonly total: number
  /** Providers that already hold a stored configuration. */
  readonly configured: number
}

/** Read-only Host RPC seam. Every reader answers `undefined` instead of throwing when it fails. */
export interface CommunityDiagnosticsRpc {
  /**
   * Supply a plain function, not a bound method.
   * @returns provider presence counts, or undefined when the round-trip failed.
   */
  readonly providers?: () => Promise<CommunityDiagnosticsProviders | undefined>
  /**
   * Supply a plain function, not a bound method.
   * @returns whether a model configuration is present, or undefined when the round-trip failed.
   */
  readonly models?: () => Promise<boolean | undefined>
}

/**
 * Update facts a community build expects to be absent.
 *
 * The community distribution serves its own updates, so a policy service, an update feed, or an
 * enabled update coordinator is a finding rather than a normal state.
 */
export interface CommunityDiagnosticsUpdates {
  /** Whether the manifest declares a mandatory-update policy. */
  readonly mandatoryPolicy: boolean
  /** Whether an update feed file (`app-update.yml`) is present beside the application. */
  readonly feed: boolean
  /** Whether the update coordinator reported itself enabled. */
  readonly enabled: boolean
}

/**
 * The Community update surface, as the running installation currently reports it.
 *
 * Every field is a fact the update service already holds, so the report describes the same state the
 * user sees rather than a second reading of the network or of the disk. Nothing here carries a URL, a
 * digest, a path, or a response body: the source is the repository in `owner/repo` form, and the
 * remaining values are the phase token, the versions, and whether a verified file exists.
 */
export interface CommunityDiagnosticsUpdateFacts {
  /** Release repository updates are read from, in `owner/repo` form; absent when none is declared. */
  readonly source?: string
  /** Channel the installation follows: `development`, `release`, or `unknown` when it declared none. */
  readonly channel: string
  /** Phase the update service last reported. */
  readonly phase: string
  /** Version the last successful check read, when it read one. */
  readonly latestVersion?: string
  /** Schema version of the last manifest that validated, when one did. */
  readonly schemaVersion?: number
  /** Whether a verified installer is currently on disk. */
  readonly stored: boolean
}

/** Session-log telemetry as the running process actually carries it. */
export interface CommunityDiagnosticsTelemetry {
  /** Effective mode from `$DSH_TELEMETRY_MODE`; undefined when the environment carries none. */
  readonly mode: string | undefined
  /**
   * Whether this variant seeded that mode for itself rather than inheriting an operator's value.
   *
   * It is what separates "disabled by default" from "disabled because someone asked for it": the
   * bootstrap seeds the mode only when the environment did not already carry one, so a report must
   * never claim the default when an operator overrode it.
   */
  readonly seededByVariant: boolean
}

/** Harness home as a probe target plus its symbolic display form. */
export interface CommunityDiagnosticsPaths {
  /** Absolute Harness home; probed, never rendered. */
  readonly home: string
  /**
   * Symbolic display form, such as `~/.dsh-community` or `$DSH_HOME`.
   *
   * The report shows only this form. A value that looks like an absolute path falls back to
   * `$DSH_HOME`, so a Windows user name cannot reach a public issue through this seam.
   */
  readonly homeDisplay: string
}

/** Operating-system facts, as the crash report already collects them. */
export interface CommunityDiagnosticsPlatform {
  readonly os: string
  readonly release: string
  readonly arch: string
}

/** Runtime versions of the shell itself. */
export interface CommunityDiagnosticsVersions {
  readonly electron: string
  readonly node: string
}

/** Every input of {@link collectCommunityDiagnostics}. */
export interface CommunityDiagnosticsInput {
  /** Variant the installation declared; diagnostics is a community-only surface. */
  readonly variant: DesktopVariant
  /** Bundle identifier the manifest declares, when it declares one. */
  readonly appId?: string
  /**
   * Version the installed application reports.
   *
   * For a packaged build this is the build version the packaging set, and for an unpackaged one the
   * upstream package version — the two are one value to the running application, and the report
   * names whichever it is as the application version rather than pretending to know which.
   */
  readonly appVersion: string
  /**
   * Community product version the build declares, in the user-facing `v` form, when it declares one.
   *
   * Absent on a build that is not the community variant, and on a community build whose version file
   * could not be read. The check separates those two by variant rather than by value, so a release
   * reports the fact as inapplicable and a community build reports it as missing.
   */
  readonly communityVersion?: string
  /** Upstream base tag the build was last synced to, when the build declares one. */
  readonly upstreamBase?: string
  /** Commit the declared upstream base named, when the running build recorded one. */
  readonly upstreamCommit?: string
  /**
   * The Community update surface, when this build has one.
   *
   * Absent on a build that wired no update service, which is a different fact from a service that has
   * not checked yet: the latter reports its own `idle` phase, and the two must not be conflated in a
   * report a user shares.
   */
  readonly update?: CommunityDiagnosticsUpdateFacts
  readonly locale: string
  readonly paths: CommunityDiagnosticsPaths
  readonly resources: CommunityDiagnosticsResources
  readonly backend: CommunityDiagnosticsBackend
  /** Absent while no Host RPC client exists; every dependent check then degrades to a warning. */
  readonly rpc?: CommunityDiagnosticsRpc
  readonly updates: CommunityDiagnosticsUpdates
  readonly telemetry: CommunityDiagnosticsTelemetry
  readonly platform: CommunityDiagnosticsPlatform
  readonly versions: CommunityDiagnosticsVersions
  readonly fs: CommunityDiagnosticsFs
  /** @returns the report time; injected so one installation renders an identical report. */
  readonly clock: () => Date
}

/** One reported check. */
export interface CommunityDiagnosticCheck {
  readonly id: CommunityDiagnosticId
  readonly state: CommunityDiagnosticsState
  /**
   * Display value the collector already reduced to a short, single-line, gate-approved form.
   *
   * It carries no credential, no probe path, and no raw exception message — but that is a property
   * of the collector, not of this type, so a view built by hand is outside the contract.
   */
  readonly value: string
  /** Stable code for a non-pass condition, when one applies. */
  readonly code?: string
}

/**
 * Everything the report renderer and the diagnostics window display.
 *
 * The renderer treats it as already safe: it re-derives nothing and filters nothing, so only
 * {@link collectCommunityDiagnostics} should produce one.
 */
export interface CommunityDiagnosticsView {
  readonly reportVersion: number
  readonly generated: string
  readonly variant: DesktopVariant
  readonly appVersion: string
  readonly bundledDsh: string
  readonly platform: string
  readonly electron: string
  readonly node: string
  readonly locale: string
  readonly checks: readonly CommunityDiagnosticCheck[]
}

/** Check counts by state. */
export interface CommunityDiagnosticsSummary {
  readonly pass: number
  readonly warn: number
  readonly fail: number
  readonly info: number
}

/** Telemetry modes the Host composition accepts; any other value is reported as unrecognized. */
const KNOWN_TELEMETRY_MODES = new Set(['DISABLED', 'FEEDBACK_ONLY'])

/**
 * Shape gates for every rendered fact.
 *
 * Each gate admits only what the real source can produce, so a value that does not match becomes a
 * placeholder instead of reaching the report. This is defence in depth, not a general secret filter:
 * it covers the fields the collector chooses to render, and it is deliberately silent about content
 * the collector never renders at all, because reading such content in order to classify it would be
 * the leak it is meant to prevent.
 */

/** A reverse-DNS bundle identifier, as an assembled manifest declares one. */
const SAFE_APP_ID = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/u

/** A package-relative label: one lowercase identifier, never a path fragment. */
const SAFE_LABEL = /^[a-z][a-z0-9-]{0,63}$/u

/** A version, a release string, or another numeric-leading build fact. */
const SAFE_VERSION = /^\d[A-Za-z0-9._+-]{0,63}$/u

/**
 * A release tag: a short name prefix, then a version that leads with a digit.
 *
 * The shape is deliberately narrow rather than merely "not a path". A tag such as `v0.2-dev` or
 * `dsh-v0.1.7-rc.2` is a prefix plus a version, and a gate that accepted any identifier-shaped token
 * would let a credential with the same character set through — which is exactly the value a report
 * must never render.
 */
const SAFE_RELEASE = /^(?:[A-Za-z][A-Za-z0-9-]{0,15}-)?v?\d[A-Za-z0-9._+-]{0,47}$/u

/** A full commit hash, or an abbreviated one as a build fact names it. */
const SAFE_COMMIT = /^[0-9a-f]{7,40}$/u

/** One platform token, as `process.platform` spells one. */
const SAFE_PLATFORM = /^[A-Za-z][A-Za-z0-9_]{0,31}$/u

/** One architecture token, as `process.arch` spells one. */
const SAFE_ARCH = /^[A-Za-z0-9_]{1,32}$/u

/** A BCP-47-shaped language tag, as `app.getLocale()` returns one. */
const SAFE_LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/u

/** Every symbolic home form the shared resolver can produce; anything else renders configured-style. */
const SYMBOLIC_HOMES = new Set<string>([
  DEFAULT_DSH_HOME_DISPLAY,
  DEFAULT_DSH_DEV_HOME_DISPLAY,
  DEFAULT_DSH_COMMUNITY_HOME_DISPLAY,
  `$${DSH_HOME_ENV}`,
])

/** Missing-file labels named before the rest are counted; keeps one value line bounded. */
const MISSING_LABELS_SHOWN = 4

/**
 * Run one synchronous probe, converting any throw into `fallback`.
 * @param probe - the probe to run.
 * @param fallback - the value a throwing probe yields.
 * @returns the probe's value, or `fallback`.
 */
function attempt<T>(probe: () => T, fallback: T): T {
  try {
    return probe()
  } catch {
    return fallback
  }
}

/**
 * Run one asynchronous probe, converting any rejection into `fallback`.
 * @param probe - the probe to run.
 * @param fallback - the value a rejecting probe yields.
 * @returns the probe's value, or `fallback`.
 */
async function attemptAsync<T>(probe: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await probe()
  } catch {
    return fallback
  }
}

/** How one write probe ended: accepted, refused, or unable to reach a verdict. */
type DirectoryWritability = 'writable' | 'refused' | 'unverified'

/**
 * Probe one path, converting a throwing probe into `unreadable` rather than into absence.
 * @param fs - the filesystem seam.
 * @param path - absolute path to probe.
 * @returns the entry the probe found, or `unreadable` when the probe itself failed.
 */
function readEntry(fs: CommunityDiagnosticsFs, path: string): CommunityDiagnosticsEntry {
  return attempt(() => fs.kind(path), 'unreadable')
}

/**
 * Run the create-then-delete write probe, keeping a refusal apart from a probe that never answered.
 * @param fs - the filesystem seam.
 * @param directory - absolute directory to probe.
 * @returns whether the directory accepted a write, refused it, or could not be probed.
 */
async function probeWritability(fs: CommunityDiagnosticsFs, directory: string): Promise<DirectoryWritability> {
  try {
    return (await fs.probeWritableDirectory(directory)) ? 'writable' : 'refused'
  } catch {
    return 'unverified'
  }
}

/**
 * Collapse a value onto a single line, so an injected newline cannot forge a report line.
 * @param value - the value to collapse.
 * @returns the value with every line break replaced by a space.
 */
function oneLine(value: string): string {
  return value.replaceAll(/[\r\n]+/gu, ' ')
}

/**
 * Render an injected fact only when it has the shape its real source produces.
 * @param value - the injected value.
 * @param pattern - the shape gate for that source.
 * @param fallback - the placeholder a value outside the shape renders as.
 * @returns the single-line value, or `fallback`.
 */
function gated(value: string, pattern: RegExp, fallback: string): string {
  const text = oneLine(value).trim()
  return pattern.test(text) ? text : fallback
}

/**
 * Keep a version only when it has the shape a real version has.
 *
 * Every version-shaped fact goes through here, including the bundled runtime version a seam reads
 * back; without that, a reader could bypass the gate the collector applies to its own arguments.
 * @param value - the untrusted fact.
 * @returns the single-line version, or undefined when it is not one.
 */
function safeVersion(value: string): string | undefined {
  const text = oneLine(value).trim()
  return SAFE_VERSION.test(text) ? text : undefined
}

/**
 * Render a build fact such as a version, or the placeholder when it is not one.
 * @param value - the injected fact.
 * @returns the single-line fact, or `unknown`.
 */
function versionField(value: string): string {
  return safeVersion(value) ?? UNKNOWN
}

/**
 * Render a release-shaped fact such as a tag, or the placeholder when it is not one.
 * @param value - the injected fact, absent when the build declared none.
 * @returns the single-line fact, or `unknown`.
 */
function releaseField(value: string | undefined): string {
  return value === undefined ? UNKNOWN : gated(value, SAFE_RELEASE, UNKNOWN)
}

/**
 * Render a commit hash, or the placeholder when it is not one.
 * @param value - the injected commit, absent when the build declared none.
 * @returns the single-line commit, or `unknown`.
 */
function commitField(value: string | undefined): string {
  return value === undefined ? UNKNOWN : gated(value, SAFE_COMMIT, UNKNOWN)
}

/**
 * Render a locale tag, refusing anything that is not one.
 * @param value - the injected locale.
 * @returns the locale, or `unknown`.
 */
function localeField(value: string): string {
  return gated(value, SAFE_LOCALE, UNKNOWN)
}

/**
 * Render a package-relative label, refusing anything path-like or capitalized.
 * @param value - the declared label.
 * @returns the label, or `unnamed` when it is not a plain lowercase identifier.
 */
function fileLabel(value: string): string {
  return gated(value, SAFE_LABEL, 'unnamed')
}

/**
 * Render the Harness home symbolically, whatever the seam supplied.
 *
 * The home is the one fact a report would otherwise leak a user name through, so only the forms the
 * shared resolver itself produces are accepted.
 * @param paths - the home probe target and its proposed display form.
 * @returns the symbolic home, or `$DSH_HOME` when the proposal is not one of those forms.
 */
function displayHome(paths: CommunityDiagnosticsPaths): string {
  const text = oneLine(paths.homeDisplay).trim()
  return SYMBOLIC_HOMES.has(text) ? text : `$${DSH_HOME_ENV}`
}

/**
 * Coerce an injected count into a bounded, non-negative integer.
 * @param value - the injected count.
 * @returns the count, clamped to 1000, or 0 when it is not a usable number.
 */
function count(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1000) : 0
}

/**
 * Name the first few entries of a list, then count the rest.
 * @param labels - the labels to summarize.
 * @returns a bounded, deterministic summary.
 */
function summarizeLabels(labels: readonly string[]): string {
  const shown = labels.slice(0, MISSING_LABELS_SHOWN)
  const hidden = labels.length - shown.length
  return hidden === 0 ? shown.join(', ') : `${shown.join(', ')} +${String(hidden)} more`
}

/**
 * Read the bundled version through the shell reader, gating it like any other rendered fact.
 *
 * A throw, a missing answer, and a value outside the safe version shape all collapse to `undefined`,
 * which the caller already reports as an unusable descriptor. The point is that the value never
 * travels onward: it is not returned raw for a caller to decide about later.
 * @param runtime - the runtime seam.
 * @returns the gated bundled version, or undefined when none can be read.
 */
async function readBundledVersion(runtime: CommunityDiagnosticsRuntime): Promise<string | undefined> {
  const version = await attemptAsync(() => runtime.read(), undefined)
  return version === undefined ? undefined : safeVersion(version)
}

/**
 * Render the injected clock as an ISO timestamp.
 * @param clock - the injected clock.
 * @returns the timestamp, or `unknown` when the clock is not usable.
 */
function generatedAt(clock: () => Date): string {
  try {
    return clock().toISOString()
  } catch {
    return UNKNOWN
  }
}

/**
 * Report the variant, which is the fact the whole surface is gated on.
 * @param input - the collector input.
 * @returns the community-edition check.
 */
function communityEditionCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'community-edition'
  if (input.variant !== DESKTOP_COMMUNITY_VARIANT) {
    return { id, state: 'WARN', value: oneLine(input.variant), code: COMMUNITY_DIAGNOSTIC_CODES.variantNotCommunity }
  }
  const appId = input.appId === undefined ? '' : gated(input.appId, SAFE_APP_ID, '')
  const suffix = appId === '' ? '' : ` appId=${appId}`
  return { id, state: 'PASS', value: `community${suffix}` }
}

/**
 * Report the application version.
 * @param input - the collector input.
 * @returns the application-version check.
 */
function applicationVersionCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'application-version'
  const version = versionField(input.appVersion)
  return version === UNKNOWN
    ? { id, state: 'FAIL', value: UNKNOWN, code: COMMUNITY_DIAGNOSTIC_CODES.applicationVersionMissing }
    : { id, state: 'PASS', value: version }
}

/**
 * Report the community product version the build declares.
 *
 * The fork versions itself on its own series, so this is the version a community user and a community
 * release note share; the application version beside it stays the upstream package or build version
 * it has always been. Only a community build declares one, so any other build reports the fact as
 * inapplicable rather than as missing. For a community build it is required: an installation that
 * cannot name its own version cannot be matched to a release, which a report should say rather than
 * pass over.
 * @param input - the collector input.
 * @returns the community-version check.
 */
function communityVersionCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'community-version'
  if (input.variant !== DESKTOP_COMMUNITY_VARIANT) return { id, state: 'INFO', value: NOT_COMMUNITY }
  const version = releaseField(input.communityVersion)
  return version === UNKNOWN
    ? { id, state: 'WARN', value: UNKNOWN, code: COMMUNITY_DIAGNOSTIC_CODES.communityVersionMissing }
    : { id, state: 'PASS', value: version }
}

/**
 * Report the upstream base this fork is currently synced to.
 * @param input - the collector input.
 * @returns the upstream-base check.
 */
function upstreamBaseCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'upstream-base'
  if (input.variant !== DESKTOP_COMMUNITY_VARIANT) return { id, state: 'INFO', value: NOT_COMMUNITY }
  const base = releaseField(input.upstreamBase)
  return base === UNKNOWN
    ? { id, state: 'WARN', value: UNKNOWN, code: COMMUNITY_DIAGNOSTIC_CODES.upstreamBaseMissing }
    : { id, state: 'PASS', value: base }
}

/**
 * Report the commit the declared upstream base named.
 *
 * A base is reported as a tag and as a commit because a tag can be moved: the tag is what a user
 * recognizes, and the commit is what makes the report reproducible a year later. Folding them into
 * one line would lose the second property.
 * @param input - the collector input.
 * @returns the upstream-commit check.
 */
function upstreamCommitCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'upstream-commit'
  if (input.variant !== DESKTOP_COMMUNITY_VARIANT) return { id, state: 'INFO', value: NOT_COMMUNITY }
  const commit = commitField(input.upstreamCommit)
  return commit === UNKNOWN
    ? { id, state: 'WARN', value: UNKNOWN, code: COMMUNITY_DIAGNOSTIC_CODES.upstreamCommitMissing }
    : { id, state: 'PASS', value: commit }
}

/**
 * Report the Harness home.
 *
 * Five outcomes are kept apart on purpose: a home that is not there yet is a first run, a home that
 * is the wrong kind of entry or that refuses a real write is a fault, and a probe that never
 * answered is neither — reporting it as "not created yet" would hide the very failure a user needs
 * to see.
 * @param input - the collector input.
 * @returns the data-directory check.
 */
async function dataDirectoryCheck(input: CommunityDiagnosticsInput): Promise<CommunityDiagnosticCheck> {
  const id = 'data-directory'
  const display = displayHome(input.paths)
  const entry = readEntry(input.fs, input.paths.home)
  if (entry === 'unreadable') {
    return { id, state: 'WARN', value: `${display} unable to inspect`, code: COMMUNITY_DIAGNOSTIC_CODES.homeProbe }
  }
  if (entry === 'absent') return { id, state: 'INFO', value: `${display} not created yet` }
  if (entry !== 'directory') {
    return { id, state: 'FAIL', value: `${display} exists but is not a directory`, code: COMMUNITY_DIAGNOSTIC_CODES.homeNotDirectory }
  }
  const writability = await probeWritability(input.fs, input.paths.home)
  if (writability === 'unverified') {
    return { id, state: 'WARN', value: `${display} writability unverified`, code: COMMUNITY_DIAGNOSTIC_CODES.homeWriteProbe }
  }
  return writability === 'writable'
    ? { id, state: 'PASS', value: `${display} exists writable` }
    : { id, state: 'FAIL', value: `${display} exists but refused a write`, code: COMMUNITY_DIAGNOSTIC_CODES.homeNotWritable }
}

/** One packaged-runtime inspection: the header fact plus its check. */
interface RuntimeInspection {
  readonly bundled: string | undefined
  readonly check: CommunityDiagnosticCheck
}

/** How the primary runtime failed to be the directory it must be, and the code for it. */
function primaryRuntimeFault(entry: CommunityDiagnosticsEntry): { readonly wording: string; readonly code: string } {
  if (entry === 'absent') {
    return { wording: 'runtime missing', code: COMMUNITY_DIAGNOSTIC_CODES.runtimePrimaryMissing }
  }
  if (entry === 'unreadable') {
    return { wording: 'runtime unverified', code: COMMUNITY_DIAGNOSTIC_CODES.runtimePrimaryInvalid }
  }
  return { wording: 'runtime is not a directory', code: COMMUNITY_DIAGNOSTIC_CODES.runtimePrimaryInvalid }
}

/**
 * Report the packaged runtime: its descriptor, its version, and its immutable primary tree.
 *
 * The four facts are required in order, and each one is checked rather than assumed: the descriptor
 * must be present, must be a file, must read a version inside the safe shape, and must be paired with
 * a primary tree that is a directory. Presence is checked by entry kind rather than by existence — a
 * directory sitting where the descriptor belongs is a broken installation, not a working one. An
 * unanswered probe is a failure for the same reason the packaged files treat one as a failure: the
 * runtime is required, so not confirming it is not the same as it being fine. The descriptor is read
 * but never verified here; a full-tree hash belongs to the build gate, not to a check a user waits
 * on.
 * @param input - the collector input.
 * @returns the bundled version, when one was read, and the packaged-runtime check.
 */
async function inspectPackagedRuntime(input: CommunityDiagnosticsInput): Promise<RuntimeInspection> {
  const id = 'packaged-runtime'
  const runtime = input.resources.runtime
  const descriptor = readEntry(input.fs, runtime.descriptor)
  if (descriptor === 'absent') {
    return { bundled: undefined, check: { id, state: 'FAIL', value: 'descriptor missing', code: COMMUNITY_DIAGNOSTIC_CODES.runtimeDescriptorMissing } }
  }
  if (descriptor !== 'file') {
    const value = descriptor === 'unreadable' ? 'descriptor unreadable' : 'descriptor is not a file'
    return { bundled: undefined, check: { id, state: 'FAIL', value, code: COMMUNITY_DIAGNOSTIC_CODES.runtimeDescriptorInvalid } }
  }
  const bundled = await readBundledVersion(runtime)
  if (bundled === undefined) {
    return { bundled: undefined, check: { id, state: 'FAIL', value: 'descriptor unreadable', code: COMMUNITY_DIAGNOSTIC_CODES.runtimeDescriptorInvalid } }
  }
  const entry = readEntry(input.fs, runtime.primary)
  if (entry !== 'directory') {
    const fault = primaryRuntimeFault(entry)
    return { bundled, check: { id, state: 'FAIL', value: `runtime ${bundled} primary ${fault.wording}`, code: fault.code } }
  }
  return { bundled, check: { id, state: 'PASS', value: `runtime ${bundled} primary present` } }
}

/** The code naming the most actionable packaged-entry fault, in a fixed precedence. */
function packagedFilesCode(missing: readonly string[], wrongKind: readonly string[]): string {
  if (missing.length > 0) return COMMUNITY_DIAGNOSTIC_CODES.packagedFileMissing
  if (wrongKind.length > 0) return COMMUNITY_DIAGNOSTIC_CODES.packagedFileKind
  return COMMUNITY_DIAGNOSTIC_CODES.packagedFileProbe
}

/**
 * Report the entries a working installation must ship, by label rather than by path.
 *
 * Each entry is compared against the kind it must be, so a directory standing in for a file fails
 * here instead of counting as present. A probe that never answered is reported as unverified rather
 * than as missing, and only labels — never paths — reach the caller.
 *
 * An unanswered probe is a failure here rather than a warning, which is the opposite of what the data
 * directory does with one: an absent packaged entry is already a fault, so an unconfirmed one cannot
 * be the milder state.
 * @param input - the collector input.
 * @returns the packaged-files check.
 */
function packagedFilesCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'packaged-files'
  const files = input.resources.files
  if (files.length === 0) return { id, state: 'INFO', value: 'no packaged files declared' }
  const missing: string[] = []
  const wrongKind: string[] = []
  const unreadable: string[] = []
  let present = 0
  for (const file of files) {
    const entry = readEntry(input.fs, file.path)
    if (entry === file.kind) present += 1
    else if (entry === 'absent') missing.push(fileLabel(file.label))
    else if (entry === 'unreadable') unreadable.push(fileLabel(file.label))
    else wrongKind.push(fileLabel(file.label))
  }
  const total = String(files.length)
  if (missing.length === 0 && wrongKind.length === 0 && unreadable.length === 0) {
    return { id, state: 'PASS', value: `${String(present)}/${total} present` }
  }
  const parts = [`${String(present)}/${total} present`]
  if (missing.length > 0) parts.push(`missing ${summarizeLabels(missing)}`)
  if (wrongKind.length > 0) parts.push(`wrong type ${summarizeLabels(wrongKind)}`)
  if (unreadable.length > 0) parts.push(`unverified ${summarizeLabels(unreadable)}`)
  return { id, state: 'FAIL', value: parts.join(', '), code: packagedFilesCode(missing, wrongKind) }
}

/**
 * Report backend availability, degrading rather than throwing when the child is absent or silent.
 *
 * A pass here means the backend answered, not merely that it claimed to be up: a `ready` phase with
 * no round-trip supplied is unverified, because the phase alone cannot tell a live child from a
 * stale one.
 * @param input - the collector input.
 * @returns the backend check.
 */
async function backendCheck(input: CommunityDiagnosticsInput): Promise<CommunityDiagnosticCheck> {
  const id = 'backend'
  const phase = input.backend.phase
  if (phase === 'starting') return { id, state: 'WARN', value: 'starting', code: COMMUNITY_DIAGNOSTIC_CODES.backendNotReady }
  if (phase === 'error') return { id, state: 'FAIL', value: 'failed to start', code: COMMUNITY_DIAGNOSTIC_CODES.backendError }
  const probe = input.backend.probe
  if (probe === undefined) {
    return { id, state: 'WARN', value: 'ready (not independently verified)', code: COMMUNITY_DIAGNOSTIC_CODES.backendNotVerified }
  }
  const answered = await attemptAsync(() => probe(), false)
  return answered
    ? { id, state: 'PASS', value: 'ready (round-trip answered)' }
    : { id, state: 'FAIL', value: 'ready but no round-trip answer', code: COMMUNITY_DIAGNOSTIC_CODES.backendRpc }
}

/**
 * Report how many providers hold a configuration, as counts rather than content.
 * @param input - the collector input.
 * @returns the provider-configuration check.
 */
async function providerConfigurationCheck(input: CommunityDiagnosticsInput): Promise<CommunityDiagnosticCheck> {
  const id = 'provider-configuration'
  const read = input.rpc?.providers
  if (read === undefined) return { id, state: 'WARN', value: 'unavailable', code: COMMUNITY_DIAGNOSTIC_CODES.backendRpc }
  const providers = await attemptAsync(() => read(), undefined)
  if (providers === undefined) return { id, state: 'WARN', value: 'unavailable', code: COMMUNITY_DIAGNOSTIC_CODES.backendRpc }
  const total = count(providers.total)
  if (total === 0) {
    return { id, state: 'WARN', value: 'no configurable providers', code: COMMUNITY_DIAGNOSTIC_CODES.providerNoneAvailable }
  }
  const configured = Math.min(count(providers.configured), total)
  const counts = `${String(configured)}/${String(total)} configured`
  if (configured === 0) return { id, state: 'WARN', value: counts, code: COMMUNITY_DIAGNOSTIC_CODES.providerNoneConfigured }
  return configured < total ? { id, state: 'WARN', value: counts } : { id, state: 'PASS', value: counts }
}

/**
 * Report whether a model configuration is present, never which model it names.
 * @param input - the collector input.
 * @returns the model-configuration check.
 */
async function modelConfigurationCheck(input: CommunityDiagnosticsInput): Promise<CommunityDiagnosticCheck> {
  const id = 'model-configuration'
  const read = input.rpc?.models
  if (read === undefined) return { id, state: 'WARN', value: 'unavailable', code: COMMUNITY_DIAGNOSTIC_CODES.backendRpc }
  const present = await attemptAsync(() => read(), undefined)
  if (present === undefined) return { id, state: 'WARN', value: 'unavailable', code: COMMUNITY_DIAGNOSTIC_CODES.backendRpc }
  return present
    ? { id, state: 'PASS', value: 'present' }
    : { id, state: 'WARN', value: 'not configured', code: COMMUNITY_DIAGNOSTIC_CODES.modelNotConfigured }
}

/**
 * Report the update mechanism, which a community build manages for itself.
 * @param input - the collector input.
 * @returns the updates check.
 */
function updatesCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'updates'
  const found: string[] = []
  if (input.updates.mandatoryPolicy) found.push('policy service')
  if (input.updates.feed) found.push('update feed')
  if (input.updates.enabled) found.push('update coordinator')
  return found.length === 0
    ? { id, state: 'INFO', value: 'community-managed (no policy service, no update feed)' }
    : { id, state: 'WARN', value: `community-managed expected, found ${found.join(', ')}`, code: COMMUNITY_DIAGNOSTIC_CODES.updatesNotCommunityManaged }
}

/**
 * Report the session-log telemetry mode as a classification, never as the environment's text.
 * @param input - the collector input.
 * @returns the telemetry check.
 */
function telemetryCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'telemetry'
  const mode = input.telemetry.mode
  if (mode === 'DISABLED') {
    return input.telemetry.seededByVariant
      ? { id, state: 'PASS', value: 'disabled by default' }
      : { id, state: 'INFO', value: 'disabled (set by environment)' }
  }
  if (mode === undefined || mode.trim() === '') {
    return { id, state: 'WARN', value: 'unset', code: COMMUNITY_DIAGNOSTIC_CODES.telemetryUnknown }
  }
  const text = KNOWN_TELEMETRY_MODES.has(mode) ? mode : 'an unrecognized mode'
  return { id, state: 'WARN', value: `set to ${text} by environment`, code: COMMUNITY_DIAGNOSTIC_CODES.telemetryOverridden }
}

/**
 * Gate the three platform facts.
 * @param platform - the injected platform facts.
 * @returns each fact, or a placeholder when it is outside its shape.
 */
function platformFacts(platform: CommunityDiagnosticsPlatform): { os: string; release: string; arch: string } {
  return {
    os: gated(platform.os, SAFE_PLATFORM, UNKNOWN),
    release: safeVersion(platform.release) ?? UNKNOWN,
    arch: gated(platform.arch, SAFE_ARCH, UNKNOWN),
  }
}

/**
 * Render the platform facts as one report field.
 * @param platform - the injected platform facts.
 * @returns `os release (arch)`.
 */
function platformField(platform: CommunityDiagnosticsPlatform): string {
  const { os, release, arch } = platformFacts(platform)
  return `${os} ${release} (${arch})`
}

/**
 * Report the operating system and architecture the shell runs on.
 * @param input - the collector input.
 * @returns the system check, always informational.
 */
function systemCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const { os, release, arch } = platformFacts(input.platform)
  return { id: 'system', state: 'INFO', value: `${os} ${release} ${arch}` }
}

/** A release repository in `owner/name` form, as the release identity declares one. */
const SAFE_REPOSITORY_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u

/** Channels the update surface distinguishes. */
const SAFE_UPDATE_CHANNEL = /^(?:development|release|unknown)$/u

/**
 * Phases the update service reports.
 *
 * The list is written out here rather than compiled into one literal because it is longer than a line
 * may be, and a regex split across lines is not a regex. Keeping it local is deliberate: this module
 * gates what it reports, so it must not acquire the update service's own runtime to do it.
 */
const UPDATE_PHASES = [
  'idle', 'checking', 'up-to-date', 'update-available', 'downloading', 'downloaded', 'verifying',
  'ready', 'network-error', 'invalid-manifest', 'download-error', 'checksum-error',
  'unsupported-platform',
]

/** One phase token, as the update surface reports one. */
const SAFE_UPDATE_PHASE = new RegExp(`^(?:${UPDATE_PHASES.join('|')})$`, 'u')

/** How one update phase is reported: its state, its value, and any code for a non-pass condition. */
function updatePhaseReport(phase: string): { readonly state: CommunityDiagnosticsState; readonly value: string; readonly code?: string } {
  switch (phase) {
    case 'idle': return { state: 'INFO', value: 'not checked yet' }
    case 'checking': return { state: 'INFO', value: 'check in progress' }
    case 'up-to-date': return { state: 'PASS', value: 'up to date' }
    case 'update-available': return { state: 'INFO', value: 'update available' }
    case 'downloading': return { state: 'INFO', value: 'download in progress' }
    case 'downloaded': return { state: 'INFO', value: 'downloaded, awaiting verification' }
    case 'verifying': return { state: 'INFO', value: 'verifying' }
    case 'ready': return { state: 'PASS', value: 'verified and ready' }
    case 'network-error':
      return { state: 'FAIL', value: 'failed: unreachable', code: COMMUNITY_DIAGNOSTIC_CODES.updateLastCheckFailed }
    case 'invalid-manifest':
      return { state: 'FAIL', value: 'failed: unusable manifest', code: COMMUNITY_DIAGNOSTIC_CODES.updateLastCheckFailed }
    case 'download-error':
      return { state: 'FAIL', value: 'failed: download', code: COMMUNITY_DIAGNOSTIC_CODES.updateLastCheckFailed }
    case 'checksum-error':
      return { state: 'FAIL', value: 'failed: checksum', code: COMMUNITY_DIAGNOSTIC_CODES.updateChecksumFailed }
    case 'unsupported-platform':
      return { state: 'WARN', value: 'no installer for this platform', code: COMMUNITY_DIAGNOSTIC_CODES.updateUnsupportedPlatform }
    default:
      return { state: 'WARN', value: UNKNOWN, code: COMMUNITY_DIAGNOSTIC_CODES.updateLastCheckFailed }
  }
}

/**
 * Report where Community updates are read from, as a repository rather than a URL.
 *
 * The repository is the fact a support conversation needs, and it is the one update fact that can be
 * checked against what the build claims to be. A full URL is deliberately not rendered: the manifest
 * address is derived from this pair, so publishing it would add nothing a reader can act on while
 * widening what a shared report exposes.
 * @param input - the collector input.
 * @returns the community-update-source check.
 */
function updateSourceCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'community-update-source'
  if (input.variant !== DESKTOP_COMMUNITY_VARIANT) return { id, state: 'INFO', value: NOT_COMMUNITY }
  const update = input.update
  if (update === undefined) return { id, state: 'INFO', value: 'not configured' }
  if (update.source === undefined) {
    return { id, state: 'WARN', value: UNKNOWN, code: COMMUNITY_DIAGNOSTIC_CODES.updateSourceMissing }
  }
  const source = gated(update.source, SAFE_REPOSITORY_LABEL, UNKNOWN)
  return source === UNKNOWN
    ? { id, state: 'WARN', value: UNKNOWN, code: COMMUNITY_DIAGNOSTIC_CODES.updateSourceMissing }
    : { id, state: 'PASS', value: source }
}

/**
 * Report the channel this installation follows.
 *
 * It is the same fact the About surface shows, read from the version the build declares, so a report
 * and the dialog cannot disagree about which series an installation is on.
 * @param input - the collector input.
 * @returns the community-update-channel check.
 */
function updateChannelCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'community-update-channel'
  if (input.variant !== DESKTOP_COMMUNITY_VARIANT) return { id, state: 'INFO', value: NOT_COMMUNITY }
  const update = input.update
  if (update === undefined) return { id, state: 'INFO', value: NOT_COMMUNITY }
  return { id, state: 'INFO', value: gated(update.channel, SAFE_UPDATE_CHANNEL, UNKNOWN) }
}

/**
 * Report what the last update check found.
 *
 * The phase is reported as a classification rather than as an error message: the update service
 * already reduced every failure to a phase and a code, and a shared report must not carry the text a
 * response or a transport produced.
 * @param input - the collector input.
 * @returns the community-update-last-check check.
 */
function updateLastCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'community-update-last-check'
  if (input.variant !== DESKTOP_COMMUNITY_VARIANT) return { id, state: 'INFO', value: NOT_COMMUNITY }
  const update = input.update
  if (update === undefined) return { id, state: 'INFO', value: NOT_COMMUNITY }
  const phase = oneLine(update.phase).trim()
  if (!SAFE_UPDATE_PHASE.test(phase)) {
    return { id, state: 'WARN', value: UNKNOWN, code: COMMUNITY_DIAGNOSTIC_CODES.updateLastCheckFailed }
  }
  const report = updatePhaseReport(phase)
  return { id, state: report.state, value: report.value, ...report.code === undefined ? {} : { code: report.code } }
}

/**
 * Report the newest Community version the last successful check read.
 *
 * It is reported separately from the check result because the two answer different questions: one is
 * whether anything was offered, and this one is what the release line currently is — a fact a user on
 * the development channel sees without being offered a download.
 * @param input - the collector input.
 * @returns the community-update-latest check.
 */
function updateLatestCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'community-update-latest'
  if (input.variant !== DESKTOP_COMMUNITY_VARIANT) return { id, state: 'INFO', value: NOT_COMMUNITY }
  const update = input.update
  if (update === undefined || update.latestVersion === undefined) return { id, state: 'INFO', value: UNKNOWN }
  return { id, state: 'INFO', value: releaseField(update.latestVersion) }
}

/**
 * Report the schema version of the last manifest that validated.
 * @param input - the collector input.
 * @returns the community-update-manifest check.
 */
function updateManifestCheck(input: CommunityDiagnosticsInput): CommunityDiagnosticCheck {
  const id = 'community-update-manifest'
  if (input.variant !== DESKTOP_COMMUNITY_VARIANT) return { id, state: 'INFO', value: NOT_COMMUNITY }
  const schema = input.update?.schemaVersion
  return { id, state: 'INFO', value: schema === undefined ? UNKNOWN : versionField(String(schema)) }
}

/**
 * Report whether a Community installer is on disk, and whether it passed verification.
 *
 * The two are one check apart because they are one step apart: a transfer can be in flight, and a
 * file is only ever promoted after its digest matched, so "on disk" already implies "verified" — and
 * a checksum failure is reported as a failed verification rather than as an absent file.
 * @param input - the collector input.
 * @returns the community-update-download and community-update-checksum checks.
 */
function updateDownloadChecks(input: CommunityDiagnosticsInput): readonly CommunityDiagnosticCheck[] {
  const downloadId = 'community-update-download'
  const checksumId = 'community-update-checksum'
  if (input.variant !== DESKTOP_COMMUNITY_VARIANT) {
    return [
      { id: downloadId, state: 'INFO', value: NOT_COMMUNITY },
      { id: checksumId, state: 'INFO', value: NOT_COMMUNITY },
    ]
  }
  const update = input.update
  if (update === undefined) {
    return [
      { id: downloadId, state: 'INFO', value: NOT_COMMUNITY },
      { id: checksumId, state: 'INFO', value: NOT_COMMUNITY },
    ]
  }
  if (update.phase === 'checksum-error') {
    return [
      { id: downloadId, state: 'WARN', value: 'blocked', code: COMMUNITY_DIAGNOSTIC_CODES.updateChecksumFailed },
      { id: checksumId, state: 'FAIL', value: 'failed', code: COMMUNITY_DIAGNOSTIC_CODES.updateChecksumFailed },
    ]
  }
  if (update.stored) {
    return [
      { id: downloadId, state: 'PASS', value: 'verified installer on disk' },
      { id: checksumId, state: 'PASS', value: 'verified' },
    ]
  }
  const inFlight = update.phase === 'downloading' || update.phase === 'downloaded' || update.phase === 'verifying'
  return [
    { id: downloadId, state: 'INFO', value: inFlight ? 'download in progress' : 'no installer on disk' },
    { id: checksumId, state: 'INFO', value: 'not verified yet' },
  ]
}

/**
 * Collect every Phase 1 diagnostic into one deterministic view.
 *
 * Checks are produced in {@link COMMUNITY_DIAGNOSTIC_IDS} order. Gating happens here, so the returned
 * view is the last point at which a seam's answer can still be rejected; nothing downstream revisits
 * it. Nothing here throws on account of an input either: a seam that fails narrows the fact it was
 * asked for rather than failing the collection.
 * @param input - the injected facts and probes.
 * @returns the view the renderer and the diagnostics window consume.
 */
export async function collectCommunityDiagnostics(input: CommunityDiagnosticsInput): Promise<CommunityDiagnosticsView> {
  const runtime = await inspectPackagedRuntime(input)
  const checks: readonly CommunityDiagnosticCheck[] = [
    communityEditionCheck(input),
    applicationVersionCheck(input),
    await dataDirectoryCheck(input),
    runtime.check,
    packagedFilesCheck(input),
    await backendCheck(input),
    await providerConfigurationCheck(input),
    await modelConfigurationCheck(input),
    updatesCheck(input),
    telemetryCheck(input),
    systemCheck(input),
    // The three version checks are appended rather than placed beside the application version, so
    // every line an earlier report printed kept its position (see {@link COMMUNITY_DIAGNOSTIC_IDS}).
    communityVersionCheck(input),
    upstreamBaseCheck(input),
    upstreamCommitCheck(input),
    // The update checks are appended for the same reason: they describe a surface this report grew
    // later, and every line an earlier report printed keeps its position.
    updateSourceCheck(input),
    updateChannelCheck(input),
    updateLastCheck(input),
    updateLatestCheck(input),
    updateManifestCheck(input),
    ...updateDownloadChecks(input),
  ]
  return {
    reportVersion: COMMUNITY_DIAGNOSTICS_REPORT_VERSION,
    generated: generatedAt(input.clock),
    variant: input.variant,
    appVersion: versionField(input.appVersion),
    bundledDsh: runtime.bundled ?? UNKNOWN,
    platform: platformField(input.platform),
    electron: versionField(input.versions.electron),
    node: versionField(input.versions.node),
    locale: localeField(input.locale),
    checks,
  }
}

/**
 * Count checks by state.
 * @param checks - the checks to count.
 * @returns the counts, in the order the report prints them.
 */
export function summarizeCommunityDiagnostics(checks: readonly CommunityDiagnosticCheck[]): CommunityDiagnosticsSummary {
  const summary = { pass: 0, warn: 0, fail: 0, info: 0 }
  for (const check of checks) {
    if (check.state === 'PASS') summary.pass += 1
    else if (check.state === 'WARN') summary.warn += 1
    else if (check.state === 'FAIL') summary.fail += 1
    else summary.info += 1
  }
  return summary
}

/**
 * Render one check line.
 *
 * Collapsing to a single line is a formatting measure — it stops a value from forging a second
 * report line — and not a filter. The value is printed as the collector left it.
 * @param check - the check to render.
 * @returns `[STATE] id value`, with ` code=<CODE>` appended when the check carries one.
 */
function renderCheckLine(check: CommunityDiagnosticCheck): string {
  const code = check.code === undefined ? '' : ` code=${check.code}`
  return `[${check.state}] ${check.id} ${oneLine(check.value)}${code}`
}

/**
 * Render the shareable plain-text report: fixed header fields, one line per check, then the counts.
 *
 * This is a pure formatter for a view the collector produced. It re-derives no fact and sanitizes
 * nothing, so a secret can only reach the text if the collector failed to gate it — which is where
 * the guarantee lives. The text is a pure function of the view, so the window and the clipboard can
 * never disagree, and two reports of one installation differ only in the `generated` line.
 * @param view - the collected facts.
 * @returns the complete report, newline-terminated, suitable for a GitHub issue.
 */
export function renderCommunityDiagnosticsReport(view: CommunityDiagnosticsView): string {
  const summary = summarizeCommunityDiagnostics(view.checks)
  return [
    'DeepSeek Harness — Community Diagnostics',
    `report version: ${String(view.reportVersion)}`,
    `generated: ${view.generated}`,
    `variant: ${view.variant}`,
    `app version: ${view.appVersion}`,
    `bundled dsh: ${view.bundledDsh}`,
    `platform: ${view.platform}`,
    `electron: ${view.electron}`,
    `node: ${view.node}`,
    `locale: ${view.locale}`,
    '',
    ...view.checks.map(renderCheckLine),
    '',
    `summary: ${String(summary.pass)} pass, ${String(summary.warn)} warn, ${String(summary.fail)} fail, ${String(summary.info)} info`,
    '',
  ].join('\n')
}
