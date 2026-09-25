import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  desktopTargetBuildPaths,
  desktopTargetPlatform,
  developmentRuntimeDirectory,
  resolveDesktopBuildTarget,
} from '../scripts/desktop-build-paths.mjs'
import { DESKTOP_DEV_VARIANT, DESKTOP_PRODUCTION_VARIANT } from '../scripts/desktop-release-environment.mjs'
import type { DesktopVariant } from '../scripts/desktop-release-environment.mjs'
import {
  WINDOWS_OFFICE_PROGRAM_DIRECTORY_BUDGET,
  windowsOfficeProgramDirectory,
} from '../scripts/windows-asar-unpack.mjs'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
/** electron-builder assembles the application here before it appends the engine's own path. */
const windowsAssembledResources = (artifactsRoot: string): string => join(artifactsRoot, 'win-unpacked', 'resources')

describe('desktop build paths', () => {
  it('isolates every mutable build directory by complete target', () => {
    const arm64 = desktopTargetBuildPaths('mac-arm64')
    const x64 = desktopTargetBuildPaths('mac-x64')
    const windows = desktopTargetBuildPaths('win-x64')
    const mutableKeys = [
      'root',
      'artifacts',
      'unsignedArtifacts',
      'runtime',
      'packageSet',
      'dsh',
      'dshPnpm',
      'electron',
      'packedDsh',
      'packedVendor',
      'packedLandlock',
    ] as const

    for (const key of mutableKeys) {
      expect(new Set([arm64[key], x64[key], windows[key]]).size).toBe(3)
    }
    expect(arm64.artifacts).toContain(join('targets', 'mac-arm64', 'artifacts'))
    expect(x64.dsh).toContain(join('targets', 'mac-x64', 'dsh'))
    expect(windows.runtime).toContain(join('targets', 'win-x64', 'runtime'))
  })

  it('assembles the Windows unsigned application at the repository build root', () => {
    // electron-builder appends win-unpacked/resources/app.asar.unpacked/dsh/node_modules/
    // @deepseek-ai/libreoffice-kit-win32-x64/program/program to this root. Keeping it at the build
    // root, rather than under targets/win-x64/, is what leaves the checkout enough headroom for the
    // pinned engine's --program-directory budget that verifyWindowsOfficeEnginePathBudget enforces.
    const windows = desktopTargetBuildPaths('win-x64')
    expect(relative(REPOSITORY_ROOT, windows.unsignedArtifacts)).toBe(join('.dsh-build', 'win-x64'))
  })

  it('gives the development variant a shallow output root of its own', () => {
    const production = desktopTargetBuildPaths('win-x64', DESKTOP_PRODUCTION_VARIANT)
    const development = desktopTargetBuildPaths('win-x64', DESKTOP_DEV_VARIANT)
    // Each variant owns one root for both signing statuses. Only the variant marker distinguishes the
    // two names, so neither build can overwrite the other's installer, blockmap, or assembled
    // application, and the development root stays as shallow as the release root.
    expect(relative(REPOSITORY_ROOT, development.unsignedArtifacts)).toBe(join('.dsh-build', 'win-x64-dev'))
    expect(relative(REPOSITORY_ROOT, development.artifacts)).toBe(join('.dsh-build', 'win-x64-dev'))
    expect(development.unsignedArtifacts).not.toBe(production.unsignedArtifacts)
    expect(development.artifacts).not.toBe(production.artifacts)
    expect(relative(REPOSITORY_ROOT, development.unsignedArtifacts).split(sep)).toHaveLength(2)
  })

  it('relocates only the Windows output, because the development variant is Windows-only', () => {
    const production = desktopTargetBuildPaths('win-x64', DESKTOP_PRODUCTION_VARIANT)
    const development = desktopTargetBuildPaths('win-x64', DESKTOP_DEV_VARIANT)
    // The preparation trees are shared, so a development build reuses the same downloaded runtime and
    // only its own output moves; nothing identity-dependent lives in them.
    for (const key of ['root', 'runtime', 'packageSet', 'dsh', 'dshPnpm', 'electron', 'packedDsh', 'downloads'] as const) {
      expect(development[key], `${key} must stay shared`).toBe(production[key])
    }
    // electron-builder refuses the development variant off Windows, so no other target may move.
    for (const target of ['mac-arm64', 'mac-x64'] as const) {
      expect(desktopTargetBuildPaths(target, DESKTOP_DEV_VARIANT))
        .toEqual(desktopTargetBuildPaths(target, DESKTOP_PRODUCTION_VARIANT))
    }
  })

  it('keeps the development Windows application inside the Office path budget', () => {
    const measured = (variant: DesktopVariant): string => windowsOfficeProgramDirectory(
      windowsAssembledResources(desktopTargetBuildPaths('win-x64', variant).unsignedArtifacts), 'win32', 'x64')
    const production = measured(DESKTOP_PRODUCTION_VARIANT)
    const development = measured(DESKTOP_DEV_VARIANT)
    // Longer by exactly the marker, and the reason the development root may not move back under
    // targets/win-x64/: the pinned engine's fixed path buffer fails above the budget.
    expect(development.length).toBe(production.length + '-dev'.length)
    expect(production.length).toBeLessThanOrEqual(WINDOWS_OFFICE_PROGRAM_DIRECTORY_BUDGET)
    expect(development.length).toBeLessThanOrEqual(WINDOWS_OFFICE_PROGRAM_DIRECTORY_BUDGET)
  })

  it('shares only the immutable upstream download cache', () => {
    const arm64 = desktopTargetBuildPaths('mac-arm64')
    const x64 = desktopTargetBuildPaths('mac-x64')
    expect(arm64.downloads).toBe(x64.downloads)
    expect(arm64.downloads).not.toContain(`${sep}targets${sep}`)
  })

  it('resolves the development primary runtime from the build target rather than the host architecture', () => {
    expect(developmentRuntimeDirectory({}, 'darwin', 'arm64'))
      .toContain(join('targets', 'mac-arm64', 'runtime', 'primary-runtime'))
    expect(developmentRuntimeDirectory({}, 'darwin', 'x64'))
      .toContain(join('targets', 'mac-x64', 'runtime', 'primary-runtime'))
    expect(developmentRuntimeDirectory({}, 'win32', 'arm64'))
      .toContain(join('targets', 'win-x64', 'runtime', 'primary-runtime'))
  })

  it('maps every target to the platform and architecture of the payload it prepares', () => {
    expect(desktopTargetPlatform('mac-arm64')).toEqual({ platform: 'darwin', arch: 'arm64' })
    expect(desktopTargetPlatform('mac-x64')).toEqual({ platform: 'darwin', arch: 'x64' })
    expect(desktopTargetPlatform('win-x64')).toEqual({ platform: 'win32', arch: 'x64' })
    expect(() => desktopTargetPlatform('linux-x64' as 'mac-x64')).toThrow(/unsupported target/u)
  })

  it('resolves environment overrides and rejects unsupported targets', () => {
    expect(resolveDesktopBuildTarget({
      DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
    }, 'darwin', 'arm64')).toBe('mac-x64')
    expect(resolveDesktopBuildTarget({}, 'win32', 'x64')).toBe('win-x64')
    expect(() => resolveDesktopBuildTarget({}, 'linux', 'x64')).toThrow(/unsupported target/u)
    expect(() => desktopTargetBuildPaths('linux-x64' as 'mac-x64')).toThrow(/unsupported target/u)
  })
})
