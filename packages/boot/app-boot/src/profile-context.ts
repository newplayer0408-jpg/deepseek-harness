/** Launcher-owned profile locations and composition inputs. */
import { join } from 'node:path'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches } from './index.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** Application-owned package manager executable; environment applies only to package operations. */
export interface ProfilePnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Current profile facts; scheduling and mutation belong to their callers. */
export interface ProfileContext {
  readonly name: string
  /** Packaged applications supply their bundled runtime instead of a PATH executable. */
  readonly packageManager?: ProfilePnpmInvocation
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, before any persisted edits. */
  readonly startedBundles: readonly string[]
  /** Parsed command-line overlays, applied above profile and home patches. */
  readonly overlays: readonly PatchOptions[]
  /** Launch-time DSH_TELEMETRY_DISABLED value; any non-empty value opts out. */
  readonly telemetryDisabledEnv: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileContext: ProfileContext
  }
}

/**
 * Composition rows that carry telemetry or product analytics off the machine.
 *
 * The opt-out covers the whole set rather than the session-log row alone: a bundle may insert a
 * second exporter, and an opt-out that missed it would report success while records still left the
 * machine. The `dsh-v0.2.0-rc.2` web-app bundle is the reason this is a list — it added a
 * Desktop-only product-telemetry exporter and a product-analytics client beside the session row,
 * neither of which reads an environment mode of its own.
 *
 * Extend this list when a bundle adds such a row:
 * `apps/desktop/tests/community-telemetry-isolation.spec.ts` enumerates the rows the shipped
 * bundles declare and fails when one of them is missing here.
 */
export const TELEMETRY_ROW_IDS = [
  'session-telemetry-otel',
  'desktop-product-telemetry',
  'product-analytics',
] as const

/** The session-log row, and the only row the single-row seam reports. */
const TELEMETRY_ROW_ID = TELEMETRY_ROW_IDS[0]

/**
 * Resolve the telemetry opt-out switch into its boot patches. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. Only rows the composition actually carries
 * are patched, so a composition without them exports nothing: the switch is then
 * trivially satisfied and no patch is generated — custom profiles need not mount
 * telemetry to run with the switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param presentRowIds - row ids the caller found in the ordered patches.
 * @returns one disable patch per telemetry row the composition carries; empty when none apply.
 */
export function resolveTelemetryPatches(
  disabledEnv: string | undefined,
  presentRowIds: Iterable<string>,
): PatchOptions[] {
  if ((disabledEnv ?? '') === '') return []
  const present = new Set(presentRowIds)
  const patches: PatchOptions[] = []
  for (const id of TELEMETRY_ROW_IDS) {
    if (present.has(id)) patches.push({ id, disabled: true })
  }
  return patches
}

/**
 * Resolve the telemetry opt-out switch for the session-log row alone.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  return resolveTelemetryPatches(disabledEnv, hasRow ? [TELEMETRY_ROW_ID] : [])[0]
}

/** Read current bundle and user layers with the launch-time overlays.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Detached ordered patches; this function does not update the Loader.
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false })
  const patches = structuredClone([
    ...profile.layers.flatMap(layer => layer.patches),
    ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []),
    ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []),
    ...context.overlays,
  ])
  // One patch per telemetry row the composed profile actually carries, so the opt-out cannot be
  // satisfied by disabling a row this composition does not mount while another one keeps exporting.
  const composed = composeEntries([patches])
  patches.push(...resolveTelemetryPatches(context.telemetryDisabledEnv,
    composed.flatMap(entry => entry.id === undefined ? [] : [entry.id])))
  return patches
}
