/**
 * Signing status and product variant are independent inputs. An unsigned release keeps the release
 * identity, and only an explicitly selected development variant takes a derived identity that
 * cannot share an install directory, an uninstall entry, a shortcut, or a state root with a release.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppInfo, Packager } from 'app-builder-lib'
import { describe, expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import {
  deriveDesktopDevIdentity,
  DESKTOP_DEV_VARIANT,
  DESKTOP_PRODUCTION_VARIANT,
  DESKTOP_VARIANT_ENV,
  DESKTOP_VARIANT_METADATA,
  desktopVariantSuffix,
  DEV_APP_ID_SUFFIX,
  DEV_PACKAGE_NAME,
  DEV_PRODUCT_NAME,
  resolveDesktopAppId,
  resolveDesktopVariant,
} from '../scripts/desktop-release-environment.mjs'

const require = createRequire(import.meta.url)
const templates = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis')
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

const RELEASE_APP_ID = 'com.deepseek.harness'
const RELEASE_PRODUCT_NAME = 'DeepSeek Harness'
/** macOS keeps the signed release path reachable without Windows signing credentials. */
const macOSReleaseEnvironment = {
  DSH_DESKTOP_APP_ID: RELEASE_APP_ID,
  DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://harness-test.deepseek.com',
  DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
  DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
  DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
  APPLE_KEYCHAIN_PROFILE: 'identity-test',
}
/** Windows with no signing credentials at all: the release identity must not need a certificate. */
const windowsUnsignedEnvironment = {
  DSH_DESKTOP_APP_ID: RELEASE_APP_ID,
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
  DSH_DESKTOP_TARGET_PLATFORM: 'win32',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: '1',
}
const productManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }

/** Identity inputs electron-builder turns into the NSIS defines and Electron's user-data path. */
interface InstalledIdentity {
  /** APP_ID, and the UUID.v5 input for APP_GUID, which names both registry keys. */
  readonly appId: string
  /** PRODUCT_NAME. */
  readonly productName: string
  /** PRODUCT_FILENAME, APP_FILENAME (the default installation directory) and the executable name. */
  readonly productFilename: string
  /** SHORTCUT_NAME, which names both the Start Menu link and the desktop link. */
  readonly shortcutName: string
  /** APP_PACKAGE_NAME, which nests Electron's user data under %APPDATA% and is what the uninstaller deletes. */
  readonly packageName: string
  /** DSH_UPDATER_CACHE_NAME. */
  readonly updaterCacheDirName: string
}

/**
 * Read the identity inputs electron-builder turns into the NSIS defines and Electron's user-data path.
 * @param config - Configuration produced for one build.
 * @returns The inputs `NsisTarget` and `AppInfo` derive every installed identity from.
 */
function installedIdentity(config: ReturnType<typeof createElectronBuilderConfig>): InstalledIdentity {
  const metadata = { ...productManifest, ...(config.extraMetadata ?? {}) }
  const packager = new Packager({ projectDir: tmpdir() })
  Object.defineProperties(packager, {
    config: { value: config },
    metadata: { value: metadata },
    framework: { value: { defaultAppIdPrefix: 'com.electron.' } },
    devMetadata: { value: {} },
  })
  const appInfo = new AppInfo(packager, null)
  return {
    appId: appInfo.id,
    productName: appInfo.productName,
    productFilename: appInfo.productFilename,
    shortcutName: appInfo.sanitizedProductName,
    packageName: appInfo.name,
    updaterCacheDirName: appInfo.updaterCacheDirName,
  }
}

// Resolved once at collection: the release path loads the whole builder toolchain, which must not sit
// inside a test body's timeout budget.
const releaseConfig = createElectronBuilderConfig(macOSReleaseEnvironment, 'darwin', 'arm64')
const releaseIdentity = installedIdentity(releaseConfig)
const unsignedConfig = createElectronBuilderConfig(windowsUnsignedEnvironment, 'win32', 'x64')
const unsignedIdentity = installedIdentity(unsignedConfig)
const localConfig = createElectronBuilderConfig(
  { ...windowsUnsignedEnvironment, [DESKTOP_VARIANT_ENV]: DESKTOP_DEV_VARIANT }, 'win32', 'x64')
const localIdentity = installedIdentity(localConfig)

describe('desktop product variant', () => {
  it('selects the variant from an explicit input and defaults to production', () => {
    expect(resolveDesktopVariant({})).toBe(DESKTOP_PRODUCTION_VARIANT)
    expect(resolveDesktopVariant({ [DESKTOP_VARIANT_ENV]: '   ' })).toBe(DESKTOP_PRODUCTION_VARIANT)
    expect(resolveDesktopVariant({ [DESKTOP_VARIANT_ENV]: DESKTOP_PRODUCTION_VARIANT })).toBe(DESKTOP_PRODUCTION_VARIANT)
    expect(resolveDesktopVariant({ [DESKTOP_VARIANT_ENV]: DESKTOP_DEV_VARIANT })).toBe(DESKTOP_DEV_VARIANT)
    expect(resolveDesktopAppId({ DSH_DESKTOP_APP_ID: RELEASE_APP_ID })).toBe(RELEASE_APP_ID)
  })

  it('rejects a variant it does not implement', () => {
    expect(() => { resolveDesktopVariant({ [DESKTOP_VARIANT_ENV]: 'canary' }) }).toThrow(DESKTOP_VARIANT_ENV)
  })

  it('never derives the variant from the signing status', () => {
    for (const unsigned of [undefined, '0', '1']) {
      expect(resolveDesktopVariant({ DSH_DESKTOP_UNSIGNED: unsigned })).toBe(DESKTOP_PRODUCTION_VARIANT)
    }
    for (const unsigned of ['0', '1']) {
      expect(resolveDesktopVariant({ DSH_DESKTOP_UNSIGNED: unsigned, [DESKTOP_VARIANT_ENV]: DESKTOP_DEV_VARIANT }))
        .toBe(DESKTOP_DEV_VARIANT)
    }
  })

  it('extends the release identifier instead of inventing an unrelated one', () => {
    expect(deriveDesktopDevIdentity(RELEASE_APP_ID)).toEqual({
      appId: `${RELEASE_APP_ID}${DEV_APP_ID_SUFFIX}`,
      productName: DEV_PRODUCT_NAME,
      packageName: DEV_PACKAGE_NAME,
      variant: DESKTOP_DEV_VARIANT,
    })
  })

  it('refuses an identifier the suffix would not keep well formed', () => {
    for (const invalid of ['com.deepseek harness', 'com.deepseek.harness.']) {
      expect(() => { deriveDesktopDevIdentity(invalid) }).toThrow('cannot take the .dev suffix')
    }
  })
})

describe('installed identity', () => {
  it('leaves the signed release identity exactly as it was', () => {
    expect(releaseConfig.appId).toBe(RELEASE_APP_ID)
    expect(releaseConfig.productName).toBe(RELEASE_PRODUCT_NAME)
    expect(releaseConfig.extraMetadata).not.toHaveProperty('name')
    expect(releaseConfig.extraMetadata).not.toHaveProperty(DESKTOP_VARIANT_METADATA)
  })

  it('keeps the release identity for an unsigned build, without any signing certificate', () => {
    // No DSH_DESKTOP_WINDOWS_* input is present, so a certificate cannot be what selects the identity.
    expect(unsignedConfig.appId).toBe(RELEASE_APP_ID)
    expect(unsignedConfig.productName).toBe(RELEASE_PRODUCT_NAME)
    expect(unsignedConfig.extraMetadata).not.toHaveProperty('name')
    expect(unsignedConfig.extraMetadata).not.toHaveProperty(DESKTOP_VARIANT_METADATA)
  })

  it('keeps every identity input fixed when only the signing status changes', () => {
    // Signed macOS and unsigned Windows differ in signing status; identity is not a function of it.
    for (const field of Object.keys(releaseIdentity) as Array<keyof typeof releaseIdentity>) {
      expect(unsignedIdentity[field], `${field} must not follow the signing status`).toBe(releaseIdentity[field])
    }
    expect(releaseIdentity.appId).toBe(RELEASE_APP_ID)
  })

  it('gives the development build every installed identity its own value', () => {
    const dev = deriveDesktopDevIdentity(RELEASE_APP_ID)
    expect(localIdentity.appId).toBe(dev.appId)
    expect(localIdentity.productName).toBe(DEV_PRODUCT_NAME)
    expect(localIdentity.packageName).toBe(DEV_PACKAGE_NAME)
    // Compared field by field so a future shared value names the identity it would collide on.
    for (const field of Object.keys(releaseIdentity) as Array<keyof typeof releaseIdentity>) {
      expect(localIdentity[field], `${field} must differ from the release value`).not.toBe(releaseIdentity[field])
    }
    // Electron derives its user-data directory, Chromium profile, and single-instance lock from this name.
    expect(releaseIdentity.packageName).toBe(productManifest.name)
  })

  it('names its shortcuts after the development product, never after the release', () => {
    expect(releaseIdentity.shortcutName).toBe(RELEASE_PRODUCT_NAME)
    expect(localIdentity.shortcutName).toBe(DEV_PRODUCT_NAME)
    const sources = {
      shortcuts: readFileSync(join(templates, 'include', 'installer.nsh'), 'utf8'),
      uninstall: readFileSync(join(templates, 'uninstaller.nsh'), 'utf8'),
      links: readFileSync(join(templates, 'common.nsh'), 'utf8'),
    }
    // The pinned templates keep resolving both links from this installation's own registry key and names.
    expect(sources.links).toContain('ReadRegStr $oldShortcutName SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ShortcutName')
    expect(sources.links).toContain('StrCpy $oldDesktopLink "$DESKTOP\\$oldShortcutName.lnk"')
    expect(sources.shortcuts).toContain('WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ShortcutName "${SHORTCUT_NAME}"')
    expect(sources.uninstall).toContain('Delete "$oldDesktopLink"')
    // A distinct registry key plus a distinct name means the local uninstaller cannot resolve the release link.
    expect(`${releaseIdentity.shortcutName}.lnk`).not.toBe(`${localIdentity.shortcutName}.lnk`)
  })

  it('cannot address a release data directory from the development uninstaller', () => {
    // The uninstaller deletes exactly one user-data path: its own package name under %APPDATA%.
    expect(readFileSync(join(templates, 'uninstaller.nsh'), 'utf8')).toContain('RMDir /r "$APPDATA\\${APP_PACKAGE_NAME}"')
    const segments = (value: string): string[] => value.split(/[\\/]+/u)
    const isAncestor = (parent: string, child: string): boolean => {
      const head = segments(parent)
      const tail = segments(child)
      return head.length < tail.length && head.every((part, index) => tail[index] === part)
    }
    // Both names share the `@deepseek-ai` scope but are siblings, so neither removal path contains
    // the other and the release user-data directory survives a development uninstall.
    expect(localIdentity.packageName).not.toBe(releaseIdentity.packageName)
    expect(isAncestor(localIdentity.packageName, releaseIdentity.packageName)).toBe(false)
    expect(isAncestor(releaseIdentity.packageName, localIdentity.packageName)).toBe(false)
  })
})

/**
 * Resolve the `artifactName` macros the way the NSIS and DMG targets do, so the assertions name the
 * file a user would actually download rather than the template that produces it.
 * @param config - Configuration produced for one build.
 * @param parts - Version and platform values electron-builder substitutes.
 * @returns The installed-artifact filename without a directory.
 */
function artifactFilename(
  config: ReturnType<typeof createElectronBuilderConfig>,
  parts: { readonly version: string; readonly os: string; readonly arch: string; readonly ext: string },
): string {
  return config.artifactName
    .replaceAll('${version}', parts.version)
    .replaceAll('${os}', parts.os)
    .replaceAll('${arch}', parts.arch)
    .replaceAll('${ext}', parts.ext)
}

describe('artifact names and output roots', () => {
  const windowsInstaller = { version: '2.0.0', os: 'win', arch: 'x64', ext: 'exe' } as const

  it('leaves the published release installer name exactly as it was', () => {
    // The public-facing name of an unsigned release is a published contract; it must not move.
    expect(artifactFilename(unsignedConfig, windowsInstaller)).toBe('deepseek-harness-2.0.0-win-x64-unsigned.exe')
    expect(artifactFilename(releaseConfig, { ...windowsInstaller, os: 'mac', arch: 'arm64', ext: 'dmg' }))
      .toBe('deepseek-harness-2.0.0-mac-arm64.dmg')
  })

  it('marks a development installer unmistakably and keeps its blockmap consistent', () => {
    const development = artifactFilename(localConfig, windowsInstaller)
    expect(development).toBe('deepseek-harness-2.0.0-win-x64-dev-unsigned.exe')
    // electron-builder derives the blockmap name by appending to the same artifact name, so both
    // files carry the marker and neither can pass for a release artifact.
    expect(`${development}.blockmap`).toBe('deepseek-harness-2.0.0-win-x64-dev-unsigned.exe.blockmap')
    expect(development).not.toBe(artifactFilename(unsignedConfig, windowsInstaller))
  })

  it('never marks a release artifact with the development marker', () => {
    for (const config of [releaseConfig, unsignedConfig]) {
      expect(artifactFilename(config, windowsInstaller)).not.toMatch(/-dev(?:-|\.)/u)
    }
  })

  it('derives the artifact marker from the variant alone, before the signing suffix', () => {
    expect(desktopVariantSuffix(DESKTOP_PRODUCTION_VARIANT)).toBe('')
    expect(desktopVariantSuffix(DESKTOP_DEV_VARIANT)).toBe('-dev')
    // A signed release, an unsigned release, and a development build each end differently, and the
    // variant marker sits before `-unsigned` so the two inputs never stand in for one another.
    expect(releaseConfig.artifactName).toContain('${arch}.${ext}')
    expect(unsignedConfig.artifactName).toContain('${arch}-unsigned.${ext}')
    expect(localConfig.artifactName).toContain('${arch}-dev-unsigned.${ext}')
  })

  it('writes the two variants into output roots that cannot collide', () => {
    // A release keeps its shallow Windows root; the development build gets a sibling of the same
    // depth, so the LibreOfficeKit --program-directory budget still holds for both.
    expect(relative(REPOSITORY_ROOT, unsignedConfig.directories.output)).toBe(join('.dsh-build', 'win-x64'))
    expect(relative(REPOSITORY_ROOT, localConfig.directories.output)).toBe(join('.dsh-build', 'win-x64-dev'))
    expect(unsignedConfig.directories.output).not.toBe(localConfig.directories.output)
  })
})
