/** Resolve build-owned Desktop paths without sharing mutable state across release targets. */

import { join, resolve } from 'node:path'
import { DESKTOP_PRODUCTION_VARIANT, desktopVariantSuffix, resolveDesktopVariant } from './desktop-release-environment.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const BUILD_ROOT = join(APP_ROOT, '.desktop-build')
const SUPPORTED_TARGETS = new Set(['mac-arm64', 'mac-x64', 'win-x64'])

/**
 * Repository-root directory that holds the assembled Windows application.
 *
 * electron-builder appends `win-unpacked/resources/app.asar.unpacked/dsh/node_modules/
 * @deepseek-ai/libreoffice-kit-<platform>-<arch>/program/program` to `directories.output`. The pinned
 * LibreOfficeKit native helper loads its registry through a fixed path buffer and fails above the
 * `--program-directory` budget that `verifyWindowsOfficeEnginePathBudget` enforces, so the assembled
 * application cannot live under `targets/win-x64/`: that nesting leaves a checkout no headroom.
 * `.dsh-build` is already the repository build-output root, so the existing ignore and cleanup rules
 * cover this output without another rule to keep in sync.
 *
 * Each Windows variant gets its own directory directly below this root, which is what keeps a
 * development build's assembled application as shallow as a release's and keeps the two from
 * overwriting each other's installers.
 */
const WINDOWS_ARTIFACTS_ROOT = join(REPOSITORY_ROOT, '.dsh-build')

/**
 * Resolve the fixed build target selected by a packaging environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no target override exists.
 * @param {string} hostArch - Build-host architecture used when no target override exists.
 * @returns {'mac-arm64' | 'mac-x64' | 'win-x64'} Supported Desktop target name.
 */
export function resolveDesktopBuildTarget(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
) {
  const platform = env.DSH_DESKTOP_TARGET_PLATFORM ?? env.npm_config_platform ?? hostPlatform
  const arch = env.DSH_DESKTOP_TARGET_ARCH ?? env.npm_config_arch
    ?? (platform === 'win32' || platform === 'win' ? 'x64' : hostArch)
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' || platform === 'win' ? 'win' : platform
  const target = `${os}-${arch}`
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`desktop build paths: unsupported target ${target}`)
  }
  return /** @type {'mac-arm64' | 'mac-x64' | 'win-x64'} */ (target)
}

function assertSupportedTarget(target) {
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`desktop build paths: unsupported target ${String(target)}`)
  }
}

/**
 * Return the mutable preparation and artifact directories owned by one release target and variant.
 *
 * Unsigned Windows output is the one path that does not sit under `targets/<target>/`, because the
 * assembled LibreOfficeKit engine has to stay within the Windows path budget; it remains isolated
 * by target and variant, and unsigned packaging is Windows-only.
 *
 * A development variant is only reachable on Windows (`electron-builder-config.mjs` refuses it
 * elsewhere), and it owns one shallow root of its own for both signing statuses. That keeps a
 * development installer from overwriting a release installer or an assembled application, and it
 * keeps the development application inside the same Office path budget. The preparation trees stay
 * shared, because nothing in them depends on the product identity.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64'} target - Supported Desktop target name.
 * @param {'production' | 'dev'} [variant] - Product variant; production when a build does not select one.
 * @returns {{ root: string, artifacts: string, unsignedArtifacts: string, runtime: string, packageSet: string, dsh: string, dshPnpm: string, electron: string, packedDsh: string, packedVendor: string, packedLandlock: string, downloads: string }} Target paths plus the shared immutable download cache.
 */
export function desktopTargetBuildPaths(target, variant = DESKTOP_PRODUCTION_VARIANT) {
  assertSupportedTarget(target)
  const root = join(BUILD_ROOT, 'targets', target)
  const packed = join(root, 'packed')
  const signedArtifacts = join(root, 'artifacts')
  const windows = target === 'win-x64'
  const development = variant !== DESKTOP_PRODUCTION_VARIANT
  const windowsArtifacts = join(WINDOWS_ARTIFACTS_ROOT, `${target}${desktopVariantSuffix(variant)}`)
  return {
    root,
    artifacts: windows && development ? windowsArtifacts : signedArtifacts,
    unsignedArtifacts: windows ? windowsArtifacts : join(root, 'unsigned-artifacts'),
    runtime: join(root, 'runtime'),
    packageSet: join(root, 'package-set'),
    dsh: join(root, 'dsh'),
    dshPnpm: join(root, 'dsh-pnpm'),
    electron: join(root, 'electron'),
    packedDsh: join(packed, 'dsh'),
    packedVendor: join(packed, 'vendor'),
    packedLandlock: join(packed, 'landlock'),
    downloads: join(BUILD_ROOT, 'downloads'),
  }
}

/**
 * Return the platform and architecture of the payload one release target prepares.
 * Windows is prepared as x64 only, so this differs from the build host on an arm64 Windows machine.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64'} target - Supported Desktop target name.
 * @returns {{ platform: 'darwin' | 'win32', arch: 'arm64' | 'x64' }} Platform and architecture of the prepared payload.
 */
export function desktopTargetPlatform(target) {
  assertSupportedTarget(target)
  return {
    platform: /** @type {'darwin' | 'win32'} */ (target === 'win-x64' ? 'win32' : 'darwin'),
    arch: /** @type {'arm64' | 'x64'} */ (target === 'mac-arm64' ? 'arm64' : 'x64'),
  }
}

/**
 * Resolve the paths owned by the target selected in a packaging environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no target override exists.
 * @param {string} hostArch - Build-host architecture used when no target override exists.
 * @returns {ReturnType<typeof desktopTargetBuildPaths>} Selected target paths.
 */
export function resolveDesktopTargetBuildPaths(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
) {
  return desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch), resolveDesktopVariant(env))
}

/**
 * Resolve the primary-runtime directory an unpackaged development launch uses.
 * The build target fixes Windows to x64, so the shell cannot derive this directory from
 * the architecture of the process that launched it.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no target override exists.
 * @param {string} hostArch - Build-host architecture used when no target override exists.
 * @returns {string} Primary-runtime directory prepared for the selected target.
 */
export function developmentRuntimeDirectory(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
) {
  return join(resolveDesktopTargetBuildPaths(env, hostPlatform, hostArch).runtime, 'primary-runtime')
}
