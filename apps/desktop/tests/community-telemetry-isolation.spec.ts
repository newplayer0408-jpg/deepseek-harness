/**
 * A community build must not carry telemetry or product analytics to a DeepSeek deployment.
 *
 * The session-log row has always read `$DSH_TELEMETRY_MODE`, which the variant seeds for itself. The
 * `dsh-v0.2.0-rc.2` web-app bundle then added two Desktop-only rows that read no mode at all — a
 * product-telemetry exporter and a product-analytics client — so the mode seed alone would have
 * reported success while both kept sending. The launcher's hard opt-out is the only switch that
 * reaches every telemetry row a composition mounts, and this suite enumerates the rows the shipped
 * bundles actually declare to prove the opt-out covers them.
 *
 * The point is to go red rather than to stay green: a later upstream release that adds or renames
 * such a row fails the enumeration below, which is the signal to extend the launcher's list before
 * shipping. The scope is the confirmed telemetry and product-analytics rows; that is not a claim
 * about traffic of any other kind.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  loadOverlayPatches,
  resolveTelemetryPatch,
  resolveTelemetryPatches,
  TELEMETRY_ROW_IDS,
} from '@deepseek-ai/dsh-app-boot'
import {
  applyDesktopVariantTelemetry,
  DESKTOP_COMMUNITY_VARIANT,
  DESKTOP_PRODUCTION_VARIANT,
  TELEMETRY_MODE_ENV,
  TELEMETRY_OPTOUT_ENV,
} from '../src/desktop-variant.ts'

/** Patch file of every shipped bundle, relative to this spec. */
const BUNDLE_PATCH_FILES = [
  '../../../packages/bundle/acp-app/cordis.patch.yml',
  '../../../packages/bundle/base/cordis.patch.yml',
  '../../../packages/bundle/headless/cordis.patch.yml',
  '../../../packages/bundle/sdk-app/cordis.patch.yml',
  '../../../packages/bundle/sdk-minimal/cordis.patch.yml',
  '../../../packages/bundle/web-app/cordis.patch.yml',
] as const

/** The row fields this suite reads; every other patch field is irrelevant to the enumeration. */
interface DeclaredRow {
  readonly id?: string
  readonly name?: string
  readonly config?: Record<string, unknown>
}

/** Row options a bundle declares, flat over its insert lists. */
function declaredRows(patchFile: string): DeclaredRow[] {
  const path = fileURLToPath(new URL(patchFile, import.meta.url))
  const patches: { insert?: DeclaredRow[] }[] = loadOverlayPatches('community-telemetry-isolation', path)
  return patches.flatMap(patch => patch.insert ?? [])
}

const declared: DeclaredRow[] = BUNDLE_PATCH_FILES.flatMap(declaredRows)
/** A row is telemetry-like when the package it mounts carries telemetry or product analytics. */
const telemetryRows = declared.filter(row => /telemetry|analytics/i.test(row.name ?? ''))
/** The OTel SDK bootstrap row carries no exporter of its own; the assertions below prove that. */
const otelSdkRows = declared.filter(row => row.name === '@deepseek-ai/dsh-otel')

/** Row ids the enumeration found, without the holes a row without an id leaves. */
const declaredRowIds = declared.flatMap(row => row.id === undefined ? [] : [row.id])

/** Environment a community installation seeds for itself. */
function communityEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  applyDesktopVariantTelemetry(DESKTOP_COMMUNITY_VARIANT, env)
  return env
}

describe('the bundles a community build ships', () => {
  it('declares telemetry rows, so the enumeration below is not vacuous', () => {
    expect(telemetryRows.length).toBeGreaterThanOrEqual(3)
    for (const id of ['session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics']) {
      expect(telemetryRows.map(row => row.id)).toContain(id)
    }
  })

  it('mounts the OTel SDK row without an endpoint, which is why it is not an exporter', () => {
    expect(otelSdkRows.length).toBeGreaterThan(0)
    for (const row of otelSdkRows) {
      expect(row.config?.['endpoint']).toBeUndefined()
      expect(row.config?.['url']).toBeUndefined()
    }
  })
})

describe('the community telemetry opt-out', () => {
  it('covers every telemetry row the shipped bundles declare', () => {
    const known = new Set<string>(TELEMETRY_ROW_IDS)
    // A row this enumeration found but the launcher does not know about is exactly the drift this
    // suite exists for: extend TELEMETRY_ROW_IDS before shipping that upstream release.
    expect(telemetryRows.map(row => row.id).filter(id => id === undefined || !known.has(id))).toEqual([])
  })

  it('names no row the shipped bundles no longer declare', () => {
    const shipped = new Set(declaredRowIds)
    expect(TELEMETRY_ROW_IDS.filter(id => !shipped.has(id))).toEqual([])
  })

  it('disables every telemetry row a community build mounts', () => {
    const patches = resolveTelemetryPatches(communityEnvironment()[TELEMETRY_OPTOUT_ENV], declaredRowIds)
    const disabled = new Map(patches.map(patch => [patch.id, patch.disabled]))
    for (const row of telemetryRows) expect(disabled.get(row.id)).toBe(true)
    // One row per telemetry row, not the single session-log row the pre-rc.2 mechanism returned.
    expect(patches).toHaveLength(telemetryRows.length)
  })

  it('leaves a release untouched, because a release seeds no opt-out', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applyDesktopVariantTelemetry(DESKTOP_PRODUCTION_VARIANT, env)).toBeUndefined()
    expect(env[TELEMETRY_OPTOUT_ENV]).toBeUndefined()
    expect(resolveTelemetryPatches(env[TELEMETRY_OPTOUT_ENV], declaredRowIds)).toEqual([])
  })

  it('still answers the session-log row through the single-row seam', () => {
    expect(resolveTelemetryPatch('1', true)).toEqual({ id: 'session-telemetry-otel', disabled: true })
    expect(resolveTelemetryPatch(undefined, true)).toBeUndefined()
    expect(resolveTelemetryPatch('1', false)).toBeUndefined()
  })

  it('seeds both switches, so the session row and the Desktop rows are covered', () => {
    const env = communityEnvironment()
    expect(env[TELEMETRY_MODE_ENV]).toBe('DISABLED')
    expect(env[TELEMETRY_OPTOUT_ENV]).toBe('DISABLED')
  })
})
