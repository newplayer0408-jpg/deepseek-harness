/**
 * Early product-variant bootstrap for the Electron shell.
 *
 * A variant other than a release is a separate installation, so it must not read or write the state
 * a release installation owns. Electron already separates the Chromium profile because the packaged
 * package name differs; this module separates the remaining shared root by seeding the Harness home
 * before any caller resolves a path under it.
 *
 * A community build belongs to no DeepSeek deployment as well, so the same bootstrap seeds the
 * telemetry mode the Host child process inherits. Seeding it here rather than in a build environment
 * is the point: a build variable describes the build, and only a value the packaged application sets
 * for itself reaches the Host a user runs.
 *
 * The variant is read from the assembled manifest as a typed marker. It is never inferred from the
 * product name or the signing status: an unsigned release is still a release.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultDshCommunityHome, defaultDshDevHome, DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'

/** Assembled-manifest field that carries the product variant to the application runtime. */
export const DESKTOP_VARIANT_METADATA = 'dshDesktopVariant'

/** Product variant a release ships, and the default for a build that declares none. */
export const DESKTOP_PRODUCTION_VARIANT = 'production'

/** Product variant a development build takes. */
export const DESKTOP_DEV_VARIANT = 'dev'

/** Product variant a community binary release takes. */
export const DESKTOP_COMMUNITY_VARIANT = 'community'

/** Product variant an installation takes. */
export type DesktopVariant =
  | typeof DESKTOP_PRODUCTION_VARIANT
  | typeof DESKTOP_DEV_VARIANT
  | typeof DESKTOP_COMMUNITY_VARIANT

/**
 * Environment variable that selects the session-log telemetry mode.
 *
 * A community build defaults it to {@link TELEMETRY_DISABLED_MODE}. The shared dsh base resolves an
 * unset mode to `FEEDBACK_ONLY`, which would release a session prefix to DeepSeek's collector the
 * first time a user recorded `/feedback` — a destination a community build must not reach.
 */
export const TELEMETRY_MODE_ENV = 'DSH_TELEMETRY_MODE'

/** Telemetry mode that constructs no exporter, so the installation contacts no collector. */
export const TELEMETRY_DISABLED_MODE = 'DISABLED'

/**
 * Default Harness home each variant that isolates its state owns, keyed by the variant that owns it.
 *
 * A variant absent from this map keeps the release home, so a release resolves exactly as it did.
 */
const VARIANT_HOMES: Readonly<Partial<Record<DesktopVariant, () => string>>> = {
  [DESKTOP_DEV_VARIANT]: defaultDshDevHome,
  [DESKTOP_COMMUNITY_VARIANT]: defaultDshCommunityHome,
}

/**
 * Read the product variant a packaged application declares.
 * @param manifest - Parsed application manifest.
 * @returns declared variant; production when the manifest declares none.
 * @throws when the manifest is not an object, or declares an unsupported variant.
 */
export function readDesktopVariant(manifest: unknown): DesktopVariant {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error('desktop variant: invalid application manifest')
  }
  if (!(DESKTOP_VARIANT_METADATA in manifest)) return DESKTOP_PRODUCTION_VARIANT
  const declared = manifest[DESKTOP_VARIANT_METADATA]
  if (declared === DESKTOP_PRODUCTION_VARIANT || declared === DESKTOP_DEV_VARIANT
    || declared === DESKTOP_COMMUNITY_VARIANT) return declared
  throw new Error(`desktop variant: unsupported ${DESKTOP_VARIANT_METADATA} value`)
}

/**
 * Give an installation that isolates its state its own Harness home.
 *
 * Each isolated home is a sibling of the release home, never a child, so an uninstaller that removes
 * its own installation and data directories can never reach another variant's home by walking in. An
 * operator-supplied `$DSH_HOME` is left alone: it already outranks the default, so a deliberate
 * override keeps its precedence.
 * @param variant - Product variant the installation declared.
 * @param env - Environment to seed; the caller owns the object.
 * @returns the seeded home, or undefined when the environment was left unchanged.
 */
export function applyDesktopVariantHome(
  variant: DesktopVariant,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const home = VARIANT_HOMES[variant]
  if (home === undefined) return undefined
  if ((env[DSH_HOME_ENV]?.trim() ?? '') !== '') return undefined
  const seeded = home()
  env[DSH_HOME_ENV] = seeded
  return seeded
}

/**
 * Seed the telemetry default a variant installs for itself.
 *
 * The mode is seeded only when the environment does not already carry one, so an operator who set it
 * deliberately keeps that choice — the same precedence `$DSH_HOME` already has over a variant's
 * default home. The Host child process inherits this environment, and the launcher resolves the
 * session-log exporter row from it while loading the composition.
 * @param variant - Product variant the installation declared.
 * @param env - Environment to seed; the caller owns the object.
 * @returns the seeded mode, or undefined when the environment was left unchanged.
 */
export function applyDesktopVariantTelemetry(
  variant: DesktopVariant,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (variant !== DESKTOP_COMMUNITY_VARIANT) return undefined
  if ((env[TELEMETRY_MODE_ENV]?.trim() ?? '') !== '') return undefined
  env[TELEMETRY_MODE_ENV] = TELEMETRY_DISABLED_MODE
  return TELEMETRY_DISABLED_MODE
}

/**
 * Resolve the installation's variant and isolate its state before any path is resolved.
 * @param options - Application path to read the manifest from, plus environment and read seams.
 * @returns the variant this installation declared.
 */
export async function bootstrapDesktopVariant(options: {
  readonly appPath: string
  readonly env?: NodeJS.ProcessEnv
  readonly readManifest?: (path: string) => Promise<string>
}): Promise<DesktopVariant> {
  const env = options.env ?? process.env
  const readManifest = options.readManifest ?? (async (path: string): Promise<string> => readFile(path, 'utf8'))
  const manifest: unknown = JSON.parse(await readManifest(join(options.appPath, 'package.json')))
  const variant = readDesktopVariant(manifest)
  applyDesktopVariantHome(variant, env)
  applyDesktopVariantTelemetry(variant, env)
  return variant
}
