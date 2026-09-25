/** Environment variable that supplies the Electron application identifier. */
export const DESKTOP_APP_ID_ENV: 'DSH_DESKTOP_APP_ID'

/** Environment variable that supplies electron-builder's macOS certificate qualifier. */
export const MACOS_SIGNING_IDENTITY_ENV: 'DSH_DESKTOP_MACOS_SIGNING_IDENTITY'

/** Environment variable that supplies the expected Apple Developer Team ID. */
export const MACOS_TEAM_ID_ENV: 'DSH_DESKTOP_MACOS_TEAM_ID'

/** Environment variable that selects the npm registry used for the bundled runtime install. */
export const NPM_REGISTRY_ENV: 'DSH_DESKTOP_NPM_REGISTRY'

/** Environment variable that selects the desktop product variant an installation takes. */
export const DESKTOP_VARIANT_ENV: 'DSH_DESKTOP_VARIANT'

/** Product name a release ships under. */
export const DESKTOP_PRODUCT_NAME: 'DeepSeek Harness'

/** Suffix that separates the development build from the release identity it derives from. */
export const DEV_APP_ID_SUFFIX: '.dev'

/** Product name of the development build; a release never uses it. */
export const DEV_PRODUCT_NAME: 'DeepSeek Harness Dev'

/** Marker that separates a development build's artifacts and local output root from a release's. */
export const DEV_ARTIFACT_MARKER: 'dev'

/** Package name of the development build; Electron derives its user data directory from it. */
export const DEV_PACKAGE_NAME: '@deepseek-ai/dsh-desktop-dev'

/** Product name of the community build; a release and a development build never use it. */
export const COMMUNITY_PRODUCT_NAME: 'DeepSeek Harness Community'

/** Marker that separates a community build's artifacts and local output root from a release's. */
export const COMMUNITY_ARTIFACT_MARKER: 'community'

/** Application identifier a community build installs under; pinned to the fork's own namespace. */
export const COMMUNITY_APP_ID: 'io.github.newplayer0408.deepseek-harness'

/** Package name of the community build; Electron derives its user data directory from it. */
export const COMMUNITY_PACKAGE_NAME: '@newplayer0408/dsh-desktop-community'

/** Assembled-manifest field that carries the product variant to the application runtime. */
export const DESKTOP_VARIANT_METADATA: 'dshDesktopVariant'

/** Variant a release ships, and the default for every build that does not ask for another. */
export const DESKTOP_PRODUCTION_VARIANT: 'production'

/** Variant a development build takes. */
export const DESKTOP_DEV_VARIANT: 'dev'

/** Variant a community binary release takes. */
export const DESKTOP_COMMUNITY_VARIANT: 'community'

/** Product variant an installation takes. */
export type DesktopVariant =
  | typeof DESKTOP_PRODUCTION_VARIANT
  | typeof DESKTOP_DEV_VARIANT
  | typeof DESKTOP_COMMUNITY_VARIANT

/** Installed identity of a variant that does not install under the release identity. */
export interface DesktopInstallIdentity {
  readonly appId: string
  readonly productName: string
  readonly packageName: string
  readonly variant: string
}

/**
 * Resolve the product variant this build takes.
 * @param env - Packaging environment.
 * @returns Selected product variant; production unless the environment asks for another.
 */
export function resolveDesktopVariant(env: NodeJS.ProcessEnv): DesktopVariant

/**
 * Resolve the product name a variant presents and installs under.
 * @param variant - Product variant resolved by resolveDesktopVariant.
 * @returns Product name of that variant.
 */
export function resolveDesktopProductName(variant: DesktopVariant | string): string

/**
 * Suffix that marks a variant's artifacts and its local output root.
 * @param variant - Product variant resolved by resolveDesktopVariant.
 * @returns Empty for a release, the variant marker otherwise.
 */
export function desktopVariantSuffix(variant: DesktopVariant | string): '' | '-dev' | '-community'

/**
 * Resolve the identity a variant installs under.
 * @param variant - Product variant resolved by resolveDesktopVariant.
 * @param env - Packaging environment, read only for the release identifier a development build derives from.
 * @returns Identity that cannot collide with the release, or undefined for the release identity itself.
 */
export function resolveDesktopVariantIdentity(
  variant: DesktopVariant | string,
  env: NodeJS.ProcessEnv,
): DesktopInstallIdentity | undefined

/**
 * Derive the separate identity a development build uses.
 * @param appId - Application identifier already validated for a release.
 * @returns Identity that cannot collide with a release.
 */
export function deriveDesktopDevIdentity(appId: string): DesktopInstallIdentity

/** Public identity expected on a macOS release. */
export interface MacOSSigningEnvironment {
  readonly signingIdentity: string
  readonly teamId: string
}

/** Apple ID credentials accepted by notarytool. */
export interface MacOSAppleIdNotarizationEnvironment {
  readonly appleId: string
  readonly appleIdPassword: string
  readonly teamId: string
}

/** App Store Connect API credentials accepted by notarytool. */
export interface MacOSApiKeyNotarizationEnvironment {
  readonly appleApiKey: string
  readonly appleApiKeyId: string
  readonly appleApiIssuer: string
}

/** Keychain profile accepted by notarytool. */
export interface MacOSKeychainNotarizationEnvironment {
  readonly keychainProfile: string
  readonly keychain?: string
}

/** One complete credential strategy accepted by notarytool. */
export type MacOSNotarizationEnvironment =
  | MacOSAppleIdNotarizationEnvironment
  | MacOSApiKeyNotarizationEnvironment
  | MacOSKeychainNotarizationEnvironment

/**
 * Resolve and validate the application identifier shared by every platform target.
 * @param env - Packaging environment.
 * @returns Reverse-DNS application identifier.
 */
export function resolveDesktopAppId(env: NodeJS.ProcessEnv): string

/**
 * Resolve the npm registry used to materialize the bundled runtime and its external dependencies.
 * @param env - Packaging environment.
 * @returns Registry origin; the public registry unless a local mirror is configured.
 */
export function resolveNpmRegistry(env: NodeJS.ProcessEnv): string

/**
 * Resolve and validate the public identity expected on a macOS release.
 * @param env - Packaging environment.
 * @returns Expected certificate qualifier and Team ID.
 */
export function resolveMacOSSigningEnvironment(env: NodeJS.ProcessEnv): MacOSSigningEnvironment

/**
 * Resolve one complete credential set accepted by Apple's notary service.
 * @param env - Packaging environment.
 * @returns Notary credentials without the submitted artifact path.
 */
export function resolveMacOSNotarizationEnvironment(env: NodeJS.ProcessEnv): MacOSNotarizationEnvironment
