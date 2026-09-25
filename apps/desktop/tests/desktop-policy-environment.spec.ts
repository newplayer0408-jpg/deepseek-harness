import { expect, it } from 'vitest'
import { resolveDesktopPolicyEnvironment } from '../scripts/desktop-policy-environment.mjs'
import { validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import {
  DESKTOP_COMMUNITY_VARIANT,
  DESKTOP_DEV_VARIANT,
  DESKTOP_PRODUCTION_VARIANT,
  DESKTOP_VARIANT_ENV,
} from '../scripts/desktop-release-environment.mjs'
import { resolveDesktopPolicyConfig } from '../src/mandatory-update-policy.ts'

const origins = { DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://test.example.com',
  DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://prod.example.com' }
const auth = { DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }) }
/**
 * The variant every case below shares: the release variants are the ones that resolve a policy, and
 * the community variant's exemption from that is covered by its own cases at the end.
 */
const RELEASE = DESKTOP_PRODUCTION_VARIANT

it.each(['test', 'production'] as const)('selects the %s policy and authentication together', (deployment) => {
  const policy = resolveDesktopPolicyEnvironment({ ...origins, ...(deployment === 'test' ? auth : {}), DSH_DESKTOP_AUTO_UPDATE_ENV: deployment }, RELEASE)
  const origin = deployment === 'test' ? origins.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN : origins.DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN
  expect(policy).toEqual({ origin, allowedPageOrigins: [origin],
    ...(deployment === 'test' ? { allowedAuthOrigins: ['https://login.example.com'] } : {}),
    authentication: deployment === 'test' ? 'feishu-test' : 'anonymous' })
  expect(resolveDesktopPolicyConfig(policy!)).toMatchObject(policy!)
})

it('requires only the selected origin, defaults to test, and accepts explicit page restrictions', () => {
  const policy = resolveDesktopPolicyEnvironment({
    DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: origins.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN,
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'],
      allowedPageOrigins: ['https://download.example.com'], intervalMs: 5000 }) }, RELEASE)
  expect(policy).toMatchObject({ authentication: 'feishu-test', intervalMs: 5000, allowedPageOrigins: ['https://download.example.com'] })
  expect(() => resolveDesktopPolicyEnvironment({ ...origins, DSH_DESKTOP_AUTO_UPDATE_ENV: 'prod' }, RELEASE)).toThrow('production')
})

it.each([undefined, '', 'http://test.example.com', 'https://user:secret@test.example.com',
  'https://test.example.com/api', 'https://test.example.com/?secret=value'])('rejects invalid selected origin %s', (origin) => {
  expect(() => resolveDesktopPolicyEnvironment({ ...auth, DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: origin }, RELEASE)).toThrow('HTTPS origin')
  expect(() => resolveDesktopPolicyEnvironment({ ...auth, DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: origin }, RELEASE)).not.toThrow('secret=value')
})

it.each(['{', 'null', '[]', '{"origin":"https://old.example.com"}', '{"authentication":"anonymous"}',
  '{"allowedPageOrigins":[]}', '{"allowedPageOrigins":["http://example.com"]}'])('rejects invalid or conflicting shared options %s', (options) => {
  expect(() => resolveDesktopPolicyEnvironment({ ...origins, DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: options }, RELEASE)).toThrow()
})

it.each([undefined, '[]', '["http://login.example.com"]', '["https://login.example.com/path"]',
  '["https://user:secret@login.example.com"]'])('rejects missing or invalid test login origins %s', (value) => {
  const settings = value === undefined ? {} : { allowedAuthOrigins: JSON.parse(value) as unknown }
  expect(() => resolveDesktopPolicyEnvironment(
    { ...origins, DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify(settings) }, RELEASE)).toThrow()
})

it('rejects login origins in production', () => {
  expect(() => resolveDesktopPolicyEnvironment({ ...origins, ...auth, DSH_DESKTOP_AUTO_UPDATE_ENV: 'production' }, RELEASE))
    .toThrow('must not configure allowedAuthOrigins')
})

it.each([{ unsigned: true }, { prepareOnly: true }, {}])('fails before signing/preparation when policy is absent in %j', (options) => {
  for (const platform of ['win32', 'darwin'] as const) {
    expect(() => { validateDesktopPackageEnvironment({ DSH_DESKTOP_APP_ID: 'com.example.test' }, { platform, arch: 'x64' }, options) })
      .toThrow('DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN')
  }
})

it('resolves no policy for a community build, which has no policy service to ask', () => {
  // Returning nothing is the mechanism: the packaged manifest then carries no policy field, so the
  // shell constructs no policy client and polls nothing.
  expect(resolveDesktopPolicyEnvironment({}, DESKTOP_COMMUNITY_VARIANT)).toBeUndefined()
  expect(resolveDesktopPolicyConfig(undefined)).toBeUndefined()
})

it('reads nothing for a community build, so no leftover release setting can revive the policy', () => {
  // A release origin, a release deployment selection, and even a malformed options blob are all inert:
  // the variant is decided before any of them is parsed, so none can make this build poll an origin.
  for (const environment of [
    { ...origins },
    { ...origins, ...auth, DSH_DESKTOP_AUTO_UPDATE_ENV: 'production' },
    { ...origins, DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: '{' },
  ]) {
    expect(resolveDesktopPolicyEnvironment(environment, DESKTOP_COMMUNITY_VARIANT)).toBeUndefined()
  }
})

it('skips policy only for the community variant', () => {
  // Every other variant keeps the requirement it had: absence of an origin still fails loud.
  for (const variant of [DESKTOP_PRODUCTION_VARIANT, DESKTOP_DEV_VARIANT] as const) {
    expect(() => resolveDesktopPolicyEnvironment({}, variant)).toThrow('HTTPS origin')
  }
})

it('validates a community build without a release identifier or a policy origin', () => {
  // A community build pins its own identifier and asks no policy service, so the two settings a
  // release cannot be prepared without are not required for it — and a release value left in the file
  // is ignored rather than validated, which is what proves the variant does not read it.
  for (const options of [{ unsigned: true }, { prepareOnly: true }] as const) {
    expect(() => { validateDesktopPackageEnvironment(
      { [DESKTOP_VARIANT_ENV]: DESKTOP_COMMUNITY_VARIANT }, { platform: 'win32', arch: 'x64' }, options) }).not.toThrow()
    expect(() => { validateDesktopPackageEnvironment({
      [DESKTOP_VARIANT_ENV]: DESKTOP_COMMUNITY_VARIANT,
      DSH_DESKTOP_APP_ID: 'not a reverse dns identifier',
    }, { platform: 'win32', arch: 'x64' }, options) }).not.toThrow()
  }
  // A release still requires the identifier first, so the relaxation belongs to this variant alone.
  expect(() => { validateDesktopPackageEnvironment({}, { platform: 'win32', arch: 'x64' }, { unsigned: true }) })
    .toThrow('DSH_DESKTOP_APP_ID')
})
