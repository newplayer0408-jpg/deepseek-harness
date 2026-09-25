/**
 * Signing status and product variant are independent inputs. An unsigned release keeps the release
 * identity, and only an explicitly selected variant takes an identity of its own that cannot share an
 * install directory, an uninstall entry, a shortcut, or a state root with a release or with another
 * variant. A community build pins that identity instead of deriving it, so no release setting —
 * including a release application identifier — can reach it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppInfo, Packager } from 'app-builder-lib'
import { describe, expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import {
  COMMUNITY_APP_ID,
  COMMUNITY_ARTIFACT_MARKER,
  COMMUNITY_PACKAGE_NAME,
  COMMUNITY_PRODUCT_NAME,
  deriveDesktopDevIdentity,
  DESKTOP_COMMUNITY_VARIANT,
  DESKTOP_DEV_VARIANT,
  DESKTOP_PRODUCTION_VARIANT,
  DESKTOP_VARIANT_ENV,
  DESKTOP_VARIANT_METADATA,
  desktopVariantSuffix,
  DEV_APP_ID_SUFFIX,
  DEV_ARTIFACT_MARKER,
  DEV_PACKAGE_NAME,
  DEV_PRODUCT_NAME,
  resolveDesktopAppId,
  resolveDesktopVariant,
  resolveDesktopVariantIdentity,
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

/**
 * Split a path-ish value into comparable segments.
 * @param value - Install-directory or package-name path.
 * @returns Its non-empty segments.
 */
const segments = (value: string): string[] => value.split(/[\\/]+/u)

/**
 * Whether one path value strictly contains another.
 * @param parent - Candidate ancestor.
 * @param child - Candidate descendant.
 * @returns True when the child extends the parent.
 */
function isAncestor(parent: string, child: string): boolean {
  const head = segments(parent)
  const tail = segments(child)
  return head.length < tail.length && head.every((part, index) => tail[index] === part)
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
/**
 * A community build carries the variant line and nothing else a release would configure. It states no
 * application identifier at all, which is what proves the pinned identity does not need one.
 */
const communityEnvironment = {
  [DESKTOP_VARIANT_ENV]: DESKTOP_COMMUNITY_VARIANT,
  DSH_DESKTOP_TARGET_PLATFORM: 'win32',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: '1',
}
const communityConfig = createElectronBuilderConfig(communityEnvironment, 'win32', 'x64')
const communityIdentity = installedIdentity(communityConfig)
/**
 * The same community build with release settings left in the file. Every one of them must be ignored:
 * a community binary must not be steerable by whichever release configuration happens to be present.
 */
const communityWithReleaseSettingsConfig = createElectronBuilderConfig({
  ...communityEnvironment,
  DSH_DESKTOP_APP_ID: RELEASE_APP_ID,
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: macOSReleaseEnvironment.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN,
  DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: macOSReleaseEnvironment.DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN,
}, 'win32', 'x64')

describe('desktop product variant', () => {
  it('selects the variant from an explicit input and defaults to production', () => {
    expect(resolveDesktopVariant({})).toBe(DESKTOP_PRODUCTION_VARIANT)
    expect(resolveDesktopVariant({ [DESKTOP_VARIANT_ENV]: '   ' })).toBe(DESKTOP_PRODUCTION_VARIANT)
    expect(resolveDesktopVariant({ [DESKTOP_VARIANT_ENV]: DESKTOP_PRODUCTION_VARIANT })).toBe(DESKTOP_PRODUCTION_VARIANT)
    expect(resolveDesktopVariant({ [DESKTOP_VARIANT_ENV]: DESKTOP_DEV_VARIANT })).toBe(DESKTOP_DEV_VARIANT)
    expect(resolveDesktopVariant({ [DESKTOP_VARIANT_ENV]: DESKTOP_COMMUNITY_VARIANT })).toBe(DESKTOP_COMMUNITY_VARIANT)
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

  it('leaves production to the release identity and gives the community build a pinned one', () => {
    expect(resolveDesktopVariantIdentity(DESKTOP_PRODUCTION_VARIANT, windowsUnsignedEnvironment)).toBeUndefined()
    expect(resolveDesktopVariantIdentity(DESKTOP_COMMUNITY_VARIANT, {})).toEqual({
      appId: COMMUNITY_APP_ID,
      productName: COMMUNITY_PRODUCT_NAME,
      packageName: COMMUNITY_PACKAGE_NAME,
      variant: DESKTOP_COMMUNITY_VARIANT,
    })
  })

  it('pins the community identity outside the release namespace and outside the release setting', () => {
    // The pinned identifier is what makes the variant independent: a development build needs the
    // release identifier and throws without it, while a community build resolves the same identity
    // whether that setting is absent or set to a release value.
    expect(() => resolveDesktopVariantIdentity(DESKTOP_DEV_VARIANT, {})).toThrow('DSH_DESKTOP_APP_ID')
    const pinned = resolveDesktopVariantIdentity(DESKTOP_COMMUNITY_VARIANT, {})
    for (const releaseAppId of [undefined, RELEASE_APP_ID, 'com.example.other']) {
      expect(resolveDesktopVariantIdentity(DESKTOP_COMMUNITY_VARIANT, { DSH_DESKTOP_APP_ID: releaseAppId }))
        .toEqual(pinned)
    }
    // The fork's own GitHub namespace, not DeepSeek's, and never a value derived from a release one.
    expect(COMMUNITY_APP_ID).toBe('io.github.newplayer0408.deepseek-harness')
    expect(COMMUNITY_APP_ID.startsWith('io.github.newplayer0408.')).toBe(true)
    expect(COMMUNITY_APP_ID).not.toContain('com.deepseek')
    expect(COMMUNITY_APP_ID).not.toBe(RELEASE_APP_ID)
  })

  it('refuses a variant identity off Windows, where the isolation it defines does not exist', () => {
    // The installer, the shortcut ownership, the uninstall entry, and the shallow output root are all
    // Windows concepts, so the combination fails here rather than half-way through a build.
    for (const variant of [DESKTOP_DEV_VARIANT, DESKTOP_COMMUNITY_VARIANT] as const) {
      expect(() => createElectronBuilderConfig({
        DSH_DESKTOP_APP_ID: RELEASE_APP_ID,
        DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
        [DESKTOP_VARIANT_ENV]: variant,
      }, 'darwin', 'arm64')).toThrow('requires the win32 target')
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

  it('gives the community build every installed identity its own value', () => {
    expect(communityIdentity.appId).toBe(COMMUNITY_APP_ID)
    expect(communityIdentity.productName).toBe(COMMUNITY_PRODUCT_NAME)
    expect(communityIdentity.packageName).toBe(COMMUNITY_PACKAGE_NAME)
    // Compared field by field so a future shared value names the identity it would collide on: a
    // community installation must displace neither a release nor a development installation.
    for (const field of Object.keys(releaseIdentity) as Array<keyof typeof releaseIdentity>) {
      expect(communityIdentity[field], `${field} must differ from the release value`).not.toBe(releaseIdentity[field])
      expect(communityIdentity[field], `${field} must differ from the development value`).not.toBe(localIdentity[field])
    }
  })

  it('cannot be steered by release settings left in the packaging file', () => {
    // The pinned identifier is what the whole installed identity derives from, so a release identifier,
    // a release update origin, and a release policy origin are all inert for this variant.
    expect(communityWithReleaseSettingsConfig.appId).toBe(COMMUNITY_APP_ID)
    expect(installedIdentity(communityWithReleaseSettingsConfig)).toEqual(communityIdentity)
  })

  it('carries no mandatory-update policy, so the shell builds no policy client at all', () => {
    // Omitting the field is the whole mechanism: the shell constructs its policy client only when the
    // packaged manifest carries one, so a community build polls nothing and reaches no origin.
    for (const config of [communityConfig, communityWithReleaseSettingsConfig]) {
      expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
    }
    // A release keeps the field, so the omission is specific to this variant rather than global.
    expect(unsignedConfig.extraMetadata).toHaveProperty('dshMandatoryUpdatePolicy')
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

  it('gives the community build shortcuts no other variant can resolve', () => {
    expect(communityIdentity.shortcutName).toBe(COMMUNITY_PRODUCT_NAME)
    // The pinned templates resolve both links from this installation's own registry key, so a distinct
    // shortcut name on a distinct key is what keeps a community uninstall from removing another's link.
    for (const other of [releaseIdentity.shortcutName, localIdentity.shortcutName]) {
      expect(`${communityIdentity.shortcutName}.lnk`).not.toBe(`${other}.lnk`)
    }
  })

  it('cannot address a release data directory from the development uninstaller', () => {
    // The uninstaller deletes exactly one user-data path: its own package name under %APPDATA%.
    expect(readFileSync(join(templates, 'uninstaller.nsh'), 'utf8')).toContain('RMDir /r "$APPDATA\\${APP_PACKAGE_NAME}"')
    // Both names share the `@deepseek-ai` scope but are siblings, so neither removal path contains
    // the other and the release user-data directory survives a development uninstall.
    expect(localIdentity.packageName).not.toBe(releaseIdentity.packageName)
    expect(isAncestor(localIdentity.packageName, releaseIdentity.packageName)).toBe(false)
    expect(isAncestor(releaseIdentity.packageName, localIdentity.packageName)).toBe(false)
  })

  it('cannot address another variant data directory from the community uninstaller', () => {
    // Same removal target, three sibling names: the community uninstall moves no other variant's data.
    for (const other of [releaseIdentity.packageName, localIdentity.packageName]) {
      expect(communityIdentity.packageName).not.toBe(other)
      expect(isAncestor(communityIdentity.packageName, other)).toBe(false)
      expect(isAncestor(other, communityIdentity.packageName)).toBe(false)
    }
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

  it('marks a community installer unmistakably and keeps its blockmap consistent', () => {
    const community = artifactFilename(communityConfig, windowsInstaller)
    expect(community).toBe('deepseek-harness-2.0.0-win-x64-community-unsigned.exe')
    // Both files carry the marker, so neither can pass for a release artifact or for the other variant.
    expect(`${community}.blockmap`).toBe('deepseek-harness-2.0.0-win-x64-community-unsigned.exe.blockmap')
    expect(community).not.toBe(artifactFilename(unsignedConfig, windowsInstaller))
    expect(community).not.toBe(artifactFilename(localConfig, windowsInstaller))
    expect(community).toContain(COMMUNITY_ARTIFACT_MARKER)
  })

  it('never marks a release artifact with a variant marker', () => {
    for (const config of [releaseConfig, unsignedConfig]) {
      const name = artifactFilename(config, windowsInstaller)
      expect(name).not.toMatch(/-dev(?:-|\.)/u)
      expect(name).not.toMatch(/-community(?:-|\.)/u)
    }
  })

  it('derives the artifact marker from the variant alone, before the signing suffix', () => {
    expect(desktopVariantSuffix(DESKTOP_PRODUCTION_VARIANT)).toBe('')
    expect(desktopVariantSuffix(DESKTOP_DEV_VARIANT)).toBe(`-${DEV_ARTIFACT_MARKER}`)
    expect(desktopVariantSuffix(DESKTOP_COMMUNITY_VARIANT)).toBe(`-${COMMUNITY_ARTIFACT_MARKER}`)
    // A signed release, an unsigned release, and each isolated variant end differently, and the
    // variant marker sits before `-unsigned` so the two inputs never stand in for one another.
    expect(releaseConfig.artifactName).toContain('${arch}.${ext}')
    expect(unsignedConfig.artifactName).toContain('${arch}-unsigned.${ext}')
    expect(localConfig.artifactName).toContain('${arch}-dev-unsigned.${ext}')
    expect(communityConfig.artifactName).toContain('${arch}-community-unsigned.${ext}')
  })

  it('writes each variant into an output root of its own', () => {
    // A release keeps its shallow Windows root; each isolated variant gets a sibling of the same
    // depth, so the LibreOfficeKit --program-directory budget still holds for all of them and no
    // variant's installer or assembled application can overwrite another's.
    expect(relative(REPOSITORY_ROOT, unsignedConfig.directories.output)).toBe(join('.dsh-build', 'win-x64'))
    expect(relative(REPOSITORY_ROOT, localConfig.directories.output)).toBe(join('.dsh-build', 'win-x64-dev'))
    expect(relative(REPOSITORY_ROOT, communityConfig.directories.output)).toBe(join('.dsh-build', 'win-x64-community'))
    expect(new Set([
      unsignedConfig.directories.output,
      localConfig.directories.output,
      communityConfig.directories.output,
    ]).size).toBe(3)
  })
})

describe('community license and notice packaging', () => {
  it('carries the repository license and notices beside a release file set that is untouched', () => {
    // MIT requires the notice to accompany copies, and a public community binary is a copy. The files
    // come from the repository root, so their existence is what makes the packaging step well formed.
    expect(communityConfig.extraFiles).toEqual([
      { from: join(REPOSITORY_ROOT, 'LICENSE'), to: 'licenses/LICENSE' },
      { from: join(REPOSITORY_ROOT, 'THIRD_PARTY_NOTICES.md'), to: 'licenses/THIRD_PARTY_NOTICES.md' },
    ])
    for (const entry of communityConfig.extraFiles) {
      expect(existsSync(entry.from), `${entry.from} must exist to be packaged`).toBe(true)
    }
    // extraFiles land beside the executable, where electron-builder already places Electron's own
    // notices, so nothing already packaged is replaced or nested in the archive.
    for (const entry of communityConfig.extraFiles) {
      expect(entry.to.startsWith('licenses/')).toBe(true)
    }
  })

  it('adds nothing to a release artifact file set', () => {
    expect(releaseConfig.extraFiles).toEqual([])
    expect(unsignedConfig.extraFiles).toEqual([])
  })
})
