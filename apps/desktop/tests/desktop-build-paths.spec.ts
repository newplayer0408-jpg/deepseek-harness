import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  desktopTargetBuildPaths,
  desktopTargetPlatform,
  developmentRuntimeDirectory,
  resolveDesktopBuildTarget,
  resolveDesktopTargetBuildPaths,
} from '../scripts/desktop-build-paths.mjs'
import {
  COMMUNITY_ARTIFACT_MARKER,
  DESKTOP_COMMUNITY_VARIANT,
  DESKTOP_DEV_VARIANT,
  DESKTOP_PRODUCTION_VARIANT,
  DESKTOP_VARIANT_ENV,
  DEV_ARTIFACT_MARKER,
} from '../scripts/desktop-release-environment.mjs'
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

  it('gives each isolated variant a shallow output root of its own', () => {
    const production = desktopTargetBuildPaths('win-x64', DESKTOP_PRODUCTION_VARIANT)
    const development = desktopTargetBuildPaths('win-x64', DESKTOP_DEV_VARIANT)
    const community = desktopTargetBuildPaths('win-x64', DESKTOP_COMMUNITY_VARIANT)
    // Each variant owns one root for both signing statuses. Only the variant marker distinguishes the
    // names, so no build can overwrite another's installer, blockmap, or assembled application, and
    // every isolated root stays as shallow as the release root.
    expect(relative(REPOSITORY_ROOT, development.unsignedArtifacts)).toBe(join('.dsh-build', 'win-x64-dev'))
    expect(relative(REPOSITORY_ROOT, community.unsignedArtifacts)).toBe(join('.dsh-build', 'win-x64-community'))
    expect(new Set([
      production.unsignedArtifacts,
      development.unsignedArtifacts,
      community.unsignedArtifacts,
    ]).size).toBe(3)
    for (const isolated of [development, community]) {
      expect(isolated.artifacts).toBe(isolated.unsignedArtifacts)
      expect(isolated.artifacts).not.toBe(production.artifacts)
      expect(relative(REPOSITORY_ROOT, isolated.unsignedArtifacts).split(sep)).toHaveLength(2)
    }
  })

  it('selects the isolated root from the variant in a packaging environment', () => {
    // The packaging entry point, not just the helper, has to see the variant: this is how a community
    // build reaches its own root without any other setting naming it.
    const paths = resolveDesktopTargetBuildPaths({
      [DESKTOP_VARIANT_ENV]: DESKTOP_COMMUNITY_VARIANT,
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
    })
    expect(relative(REPOSITORY_ROOT, paths.unsignedArtifacts)).toBe(join('.dsh-build', 'win-x64-community'))
    expect(relative(REPOSITORY_ROOT, resolveDesktopTargetBuildPaths({
      DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64',
    }).unsignedArtifacts)).toBe(join('.dsh-build', 'win-x64'))
  })

  it('relocates only the Windows output, because an isolated variant is Windows-only', () => {
    const production = desktopTargetBuildPaths('win-x64', DESKTOP_PRODUCTION_VARIANT)
    for (const variant of [DESKTOP_DEV_VARIANT, DESKTOP_COMMUNITY_VARIANT] as const) {
      const isolated = desktopTargetBuildPaths('win-x64', variant)
      // The preparation trees are shared, so an isolated build reuses the same downloaded runtime and
      // only its own output moves; nothing identity-dependent lives in them.
      for (const key of ['root', 'runtime', 'packageSet', 'dsh', 'dshPnpm', 'electron', 'packedDsh', 'downloads'] as const) {
        expect(isolated[key], `${variant}: ${key} must stay shared`).toBe(production[key])
      }
      // electron-builder refuses an isolated variant off Windows, so no other target may move.
      for (const target of ['mac-arm64', 'mac-x64'] as const) {
        expect(desktopTargetBuildPaths(target, variant))
          .toEqual(desktopTargetBuildPaths(target, DESKTOP_PRODUCTION_VARIANT))
      }
    }
  })

  it('keeps every isolated Windows application inside the Office path budget', () => {
    const measured = (variant: DesktopVariant): string => windowsOfficeProgramDirectory(
      windowsAssembledResources(desktopTargetBuildPaths('win-x64', variant).unsignedArtifacts), 'win32', 'x64')
    const production = measured(DESKTOP_PRODUCTION_VARIANT)
    // Longer by exactly the marker, and the reason an isolated root may not move back under
    // targets/win-x64/: the pinned engine's fixed path buffer fails above the budget.
    expect(production.length).toBeLessThanOrEqual(WINDOWS_OFFICE_PROGRAM_DIRECTORY_BUDGET)
    for (const [variant, marker] of [
      [DESKTOP_DEV_VARIANT, `-${DEV_ARTIFACT_MARKER}`],
      [DESKTOP_COMMUNITY_VARIANT, `-${COMMUNITY_ARTIFACT_MARKER}`],
    ] as const) {
      const isolated = measured(variant)
      expect(isolated.length).toBe(production.length + marker.length)
      expect(isolated.length).toBeLessThanOrEqual(WINDOWS_OFFICE_PROGRAM_DIRECTORY_BUDGET)
    }
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
