/**
 * Early product-variant bootstrap for the Electron shell.
 *
 * A development build is a separate installation, so it must not read or write the state a release
 * installation owns. Electron already separates the Chromium profile because the packaged package
 * name differs; this module separates the remaining shared root by seeding the Harness home before
 * any caller resolves a path under it.
 *
 * The variant is read from the assembled manifest as a typed marker. It is never inferred from the
 * product name or the signing status: an unsigned release is still a release.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultDshDevHome, DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'

/** Assembled-manifest field that carries the product variant to the application runtime. */
export const DESKTOP_VARIANT_METADATA = 'dshDesktopVariant'

/** Product variant a release ships, and the default for a build that declares none. */
export const DESKTOP_PRODUCTION_VARIANT = 'production'

/** Product variant a development build takes. */
export const DESKTOP_DEV_VARIANT = 'dev'

/** Product variant an installation takes. */
export type DesktopVariant = typeof DESKTOP_PRODUCTION_VARIANT | typeof DESKTOP_DEV_VARIANT

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
  if (declared === DESKTOP_PRODUCTION_VARIANT || declared === DESKTOP_DEV_VARIANT) return declared
  throw new Error(`desktop variant: unsupported ${DESKTOP_VARIANT_METADATA} value`)
}

/**
 * Give a development installation its own Harness home.
 *
 * The home is a sibling of the release home, never a child, so a release uninstaller that removes
 * its own installation and data directories can never reach it. An operator-supplied `$DSH_HOME`
 * is left alone: it already outranks the default, so a deliberate override keeps its precedence.
 * @param variant - Product variant the installation declared.
 * @param env - Environment to seed; the caller owns the object.
 * @returns the seeded dev home, or undefined when the environment was left unchanged.
 */
export function applyDesktopVariantHome(
  variant: DesktopVariant,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (variant !== DESKTOP_DEV_VARIANT) return undefined
  if ((env[DSH_HOME_ENV]?.trim() ?? '') !== '') return undefined
  const home = defaultDshDevHome()
  env[DSH_HOME_ENV] = home
  return home
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
  return variant
}
