/** Resolve the required policy service from the same deployment as updater publication. */
import { DESKTOP_COMMUNITY_VARIANT } from './desktop-release-environment.mjs'
import { resolveDesktopAutoUpdateEnvironment } from './desktop-auto-update-environment.mjs'

function origin(value, name) {
  let url
  try { url = new URL(value) } catch { throw new Error(`desktop package: ${name} requires an HTTPS origin`) }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`desktop package: ${name} requires an HTTPS origin without credentials, path, query, or fragment`)
  }
  return url.origin
}

/**
 * Resolve mandatory policy metadata before preparing artifacts or accessing signing hardware.
 * @param {NodeJS.ProcessEnv} environment File-owned release settings; the unselected origin is not required.
 * @param {string} variant Product variant resolved by `resolveDesktopVariant`.
 * @returns {{ origin: string, allowedPageOrigins: string[], authentication: 'anonymous' | 'feishu-test', [key: string]: unknown } | undefined} Selected policy, or undefined for a variant with no policy service.
 */
export function resolveDesktopPolicyEnvironment(environment, variant) {
  // A community build is not a DeepSeek deployment, so it has no policy service to ask. Returning
  // nothing is what disables the behaviour end to end: no origin is required here, the packaged
  // manifest carries no policy field, and the shell therefore builds no policy client and polls
  // nothing. Pointing the field at a placeholder or an unreachable host would keep a request path
  // alive that exists only to fail.
  if (variant === DESKTOP_COMMUNITY_VARIANT) return undefined
  const deployment = resolveDesktopAutoUpdateEnvironment(environment)
  const name = deployment === 'test' ? 'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN' : 'DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN'
  const selected = origin(environment[name], name)
  let settings = {}
  if (environment.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG !== undefined) {
    try { settings = JSON.parse(environment.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG) }
    catch { throw new Error('desktop package: DSH_DESKTOP_MANDATORY_UPDATE_CONFIG must be valid JSON') }
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)
    || 'origin' in settings || 'authentication' in settings) {
    throw new Error('desktop package: policy options must be an object without origin or authentication; use the deployment origin settings')
  }
  const pages = settings.allowedPageOrigins ?? [selected]
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('desktop package: allowedPageOrigins must be a nonempty array')
  const authOrigins = settings.allowedAuthOrigins
  if (deployment === 'test' && (!Array.isArray(authOrigins) || authOrigins.length === 0)) {
    throw new Error('desktop package: test policy requires nonempty allowedAuthOrigins')
  }
  if (deployment === 'production' && authOrigins !== undefined) {
    throw new Error('desktop package: production policy must not configure allowedAuthOrigins')
  }
  return { ...settings, origin: selected,
    allowedPageOrigins: pages.map(value => origin(value, 'allowedPageOrigins')),
    ...(deployment === 'test' ? { allowedAuthOrigins: authOrigins.map(value => origin(value, 'allowedAuthOrigins')) } : {}),
    authentication: deployment === 'test' ? 'feishu-test' : 'anonymous' }
}
