/** Resolve public release identifiers supplied by the packaging environment. */

/** Environment variable that supplies the Electron application identifier. */
export const DESKTOP_APP_ID_ENV = 'DSH_DESKTOP_APP_ID'

/** Environment variable that supplies electron-builder's macOS certificate qualifier. */
export const MACOS_SIGNING_IDENTITY_ENV = 'DSH_DESKTOP_MACOS_SIGNING_IDENTITY'

/** Environment variable that supplies the expected Apple Developer Team ID. */
export const MACOS_TEAM_ID_ENV = 'DSH_DESKTOP_MACOS_TEAM_ID'

/** Environment variable that selects the npm registry used for the bundled runtime install. */
export const NPM_REGISTRY_ENV = 'DSH_DESKTOP_NPM_REGISTRY'

/** Environment variable that selects the desktop product variant an installation takes. */
export const DESKTOP_VARIANT_ENV = 'DSH_DESKTOP_VARIANT'

const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/'

/** Reverse-DNS shape every application identifier keeps, including the local-build suffix. */
const APP_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u

/** Product name a release ships under. */
export const DESKTOP_PRODUCT_NAME = 'DeepSeek Harness'

/** Suffix that separates the development build from the release identity it derives from. */
export const DEV_APP_ID_SUFFIX = '.dev'

/** Product name of the development build; a release never uses it. */
export const DEV_PRODUCT_NAME = 'DeepSeek Harness Dev'

/** Marker that separates a development build's artifacts and local output root from a release's. */
export const DEV_ARTIFACT_MARKER = 'dev'

/** Package name of the development build; Electron derives its user data directory from it. */
export const DEV_PACKAGE_NAME = '@deepseek-ai/dsh-desktop-dev'

/** Product name of the community build; a release and a development build never use it. */
export const COMMUNITY_PRODUCT_NAME = 'DeepSeek Harness Community'

/** Marker that separates a community build's artifacts and local output root from a release's. */
export const COMMUNITY_ARTIFACT_MARKER = 'community'

/**
 * Application identifier a community build installs under.
 *
 * The identifier is pinned rather than derived from the release identifier, for two reasons that
 * both bear on who owns the namespace: deriving it would keep the value inside DeepSeek's
 * reverse-DNS namespace, and a release identifier configured for local release work could then
 * reach a publicly distributed community binary. It lives under this fork's own GitHub namespace
 * instead, so `DSH_DESKTOP_APP_ID` is not read at all for this variant.
 *
 * electron-builder derives the Windows install directory, both shortcut names, and both uninstall
 * registry keys from this value, which is what keeps a community installation and a release
 * installation from displacing each other.
 */
export const COMMUNITY_APP_ID = 'io.github.newplayer0408.deepseek-harness'

/**
 * Package name of the community build.
 *
 * Electron derives the user data directory, the Chromium profile, and the single-instance lock from
 * it, and the generated uninstaller deletes the same directory, so it sits under the fork's own
 * scope rather than sharing one with a release or a development build.
 */
export const COMMUNITY_PACKAGE_NAME = '@newplayer0408/dsh-desktop-community'

/** Assembled-manifest field that carries the product variant to the application runtime. */
export const DESKTOP_VARIANT_METADATA = 'dshDesktopVariant'

/** Variant a release ships, and the default for every build that does not ask for another. */
export const DESKTOP_PRODUCTION_VARIANT = 'production'

/** Variant a development build takes. */
export const DESKTOP_DEV_VARIANT = 'dev'

/** Variant a community binary release takes. */
export const DESKTOP_COMMUNITY_VARIANT = 'community'

/** Product variants a build may declare. */
const DESKTOP_VARIANTS = [DESKTOP_PRODUCTION_VARIANT, DESKTOP_DEV_VARIANT, DESKTOP_COMMUNITY_VARIANT]

const APPLE_API_KEY_ENV = 'APPLE_API_KEY'
const APPLE_API_KEY_ID_ENV = 'APPLE_API_KEY_ID'
const APPLE_API_ISSUER_ENV = 'APPLE_API_ISSUER'
const APPLE_ID_ENV = 'APPLE_ID'
const APPLE_APP_SPECIFIC_PASSWORD_ENV = 'APPLE_APP_SPECIFIC_PASSWORD'
const APPLE_TEAM_ID_ENV = 'APPLE_TEAM_ID'
const APPLE_KEYCHAIN_ENV = 'APPLE_KEYCHAIN'
const APPLE_KEYCHAIN_PROFILE_ENV = 'APPLE_KEYCHAIN_PROFILE'

/**
 * Read one required non-empty environment variable.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {string} name - Required variable name.
 * @returns {string} Trimmed variable value.
 */
function requireEnvironmentValue(env, name) {
  const value = env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop release environment: ${name} must be set to a non-empty value`)
  }
  return value
}

/**
 * Resolve the npm registry used to materialize the bundled runtime and its external dependencies.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {string} Registry origin; the public registry unless a local mirror is configured.
 */
export function resolveNpmRegistry(env) {
  const configured = env[NPM_REGISTRY_ENV]?.trim() ?? ''
  if (configured === '') return DEFAULT_NPM_REGISTRY
  let url
  try { url = new URL(configured) }
  catch { throw new Error(`desktop release environment: ${NPM_REGISTRY_ENV} must be an HTTPS origin`) }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`desktop release environment: ${NPM_REGISTRY_ENV} must be an HTTPS origin without credentials, path, query, or fragment`)
  }
  return url.origin
}

/**
 * Resolve and validate the application identifier shared by every platform target.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {string} Reverse-DNS application identifier.
 */
export function resolveDesktopAppId(env) {
  const appId = requireEnvironmentValue(env, DESKTOP_APP_ID_ENV)
  if (!APP_ID_PATTERN.test(appId)) {
    throw new Error(`desktop release environment: ${DESKTOP_APP_ID_ENV} must be a reverse-DNS identifier`)
  }
  return appId
}

/**
 * Resolve the product variant this build takes.
 *
 * Signing status and product variant are independent concerns. An unsigned release keeps the
 * release identity, so publishing an unsigned artifact never forks the product; only an explicit
 * variant takes an identity of its own. Absence means production, so no existing build changes
 * identity by omission.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {'production' | 'dev' | 'community'} Selected product variant.
 */
export function resolveDesktopVariant(env) {
  const configured = env[DESKTOP_VARIANT_ENV]?.trim() ?? ''
  if (configured === '') return DESKTOP_PRODUCTION_VARIANT
  if (!DESKTOP_VARIANTS.includes(configured)) {
    throw new Error(`desktop release environment: ${DESKTOP_VARIANT_ENV} must be ${DESKTOP_VARIANTS.map(name => JSON.stringify(name)).join(' or ')}`)
  }
  return configured
}

/**
 * Resolve the product name a variant presents and installs under.
 *
 * The name reaches the window, the installed directory, the executable, the shortcut, and the
 * uninstall entry, so deriving it from one variant input is what keeps a variant from presenting
 * itself as another.
 * @param {string} variant - Product variant resolved by {@link resolveDesktopVariant}.
 * @returns {string} Product name of that variant.
 */
export function resolveDesktopProductName(variant) {
  if (variant === DESKTOP_DEV_VARIANT) return DEV_PRODUCT_NAME
  if (variant === DESKTOP_COMMUNITY_VARIANT) return COMMUNITY_PRODUCT_NAME
  return DESKTOP_PRODUCT_NAME
}

/**
 * Suffix that marks a variant's artifacts and its local output root.
 *
 * It is empty for a release, so every published artifact name and output path is unchanged, and the
 * marker sits before the signing suffix so the two independent inputs stay readable side by side
 * (`deepseek-harness-<version>-win-x64-dev-unsigned.exe`). An artifact file listing therefore shows
 * both what the build is and whether it is signed, without one implying the other.
 * @param {string} variant - Product variant resolved by {@link resolveDesktopVariant}.
 * @returns {'' | '-dev' | '-community'} Empty for a release, the variant marker otherwise.
 */
export function desktopVariantSuffix(variant) {
  if (variant === DESKTOP_DEV_VARIANT) return `-${DEV_ARTIFACT_MARKER}`
  if (variant === DESKTOP_COMMUNITY_VARIANT) return `-${COMMUNITY_ARTIFACT_MARKER}`
  return ''
}

/**
 * Resolve the identity a variant installs under.
 *
 * Production resolves to undefined: it installs under the release identifier the build was
 * configured with, which is the identity every published command already uses. Each other variant
 * gets an identity that cannot collide with it, an installation, or another variant's.
 * @param {string} variant - Product variant resolved by {@link resolveDesktopVariant}.
 * @param {NodeJS.ProcessEnv} env - Packaging environment, read only for the release identifier a
 * development build is derived from.
 * @returns {{ appId: string, productName: string, packageName: string, variant: string } | undefined} Identity that cannot collide with the release, or undefined for the release identity itself.
 */
export function resolveDesktopVariantIdentity(variant, env) {
  // A development build extends the release identifier, so it stays recognizable as a variant of one
  // release rather than a different product.
  if (variant === DESKTOP_DEV_VARIANT) return deriveDesktopDevIdentity(resolveDesktopAppId(env))
  // A community build pins its own identifier instead, and therefore never reads the release one:
  // that is what makes a release setting in the fork's own dotenv file unable to reach this variant.
  if (variant === DESKTOP_COMMUNITY_VARIANT) {
    return {
      appId: COMMUNITY_APP_ID,
      productName: COMMUNITY_PRODUCT_NAME,
      packageName: COMMUNITY_PACKAGE_NAME,
      variant: DESKTOP_COMMUNITY_VARIANT,
    }
  }
  return undefined
}

/**
 * Derive the separate identity a development build uses.
 *
 * The identifier extends the release identifier instead of inventing an unrelated namespace, so a
 * development build stays recognizable as a variant of one release rather than a different product.
 * Everything else follows from it: electron-builder derives the Windows install and uninstall
 * registry keys from the application identifier, and Electron derives its user data directory from
 * the package name.
 * @param {string} appId - Application identifier already validated for a release.
 * @returns {{ appId: string, productName: string, packageName: string, variant: string }} Identity that cannot collide with a release.
 */
export function deriveDesktopDevIdentity(appId) {
  const devAppId = `${appId}${DEV_APP_ID_SUFFIX}`
  if (!APP_ID_PATTERN.test(devAppId)) {
    throw new Error(`desktop release environment: ${DESKTOP_APP_ID_ENV} cannot take the ${DEV_APP_ID_SUFFIX} suffix`)
  }
  return {
    appId: devAppId,
    productName: resolveDesktopProductName(DESKTOP_DEV_VARIANT),
    packageName: DEV_PACKAGE_NAME,
    variant: DESKTOP_DEV_VARIANT,
  }
}

/**
 * Resolve and validate the public identity expected on a macOS release.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ signingIdentity: string, teamId: string }} Expected certificate qualifier and Team ID.
 */
export function resolveMacOSSigningEnvironment(env) {
  const signingIdentity = requireEnvironmentValue(env, MACOS_SIGNING_IDENTITY_ENV)
  if (signingIdentity.startsWith('Developer ID Application:')) {
    throw new Error(`desktop release environment: ${MACOS_SIGNING_IDENTITY_ENV} must omit the "Developer ID Application:" prefix`)
  }
  const teamId = requireEnvironmentValue(env, MACOS_TEAM_ID_ENV)
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) {
    throw new Error(`desktop release environment: ${MACOS_TEAM_ID_ENV} must contain 10 uppercase letters or digits`)
  }
  return { signingIdentity, teamId }
}

/**
 * Resolve one complete credential set accepted by Apple's notary service.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ appleId: string, appleIdPassword: string, teamId: string } | { appleApiKey: string, appleApiKeyId: string, appleApiIssuer: string } | { keychainProfile: string, keychain?: string }} Notary credentials without the submitted artifact path.
 */
export function resolveMacOSNotarizationEnvironment(env) {
  const appleIdValues = [env[APPLE_ID_ENV], env[APPLE_APP_SPECIFIC_PASSWORD_ENV], env[APPLE_TEAM_ID_ENV]]
  if (appleIdValues.some(value => value !== undefined)) {
    return {
      appleId: requireEnvironmentValue(env, APPLE_ID_ENV),
      appleIdPassword: requireEnvironmentValue(env, APPLE_APP_SPECIFIC_PASSWORD_ENV),
      teamId: requireEnvironmentValue(env, APPLE_TEAM_ID_ENV),
    }
  }

  const apiKeyValues = [env[APPLE_API_KEY_ENV], env[APPLE_API_KEY_ID_ENV], env[APPLE_API_ISSUER_ENV]]
  if (apiKeyValues.some(value => value !== undefined)) {
    return {
      appleApiKey: requireEnvironmentValue(env, APPLE_API_KEY_ENV),
      appleApiKeyId: requireEnvironmentValue(env, APPLE_API_KEY_ID_ENV),
      appleApiIssuer: requireEnvironmentValue(env, APPLE_API_ISSUER_ENV),
    }
  }

  const keychainProfile = env[APPLE_KEYCHAIN_PROFILE_ENV]?.trim()
  if (keychainProfile !== undefined && keychainProfile !== '') {
    const keychain = env[APPLE_KEYCHAIN_ENV]?.trim()
    return keychain === undefined || keychain === ''
      ? { keychainProfile }
      : { keychainProfile, keychain }
  }

  throw new Error('desktop release environment: macOS packaging requires APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER; APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID; or APPLE_KEYCHAIN_PROFILE')
}
