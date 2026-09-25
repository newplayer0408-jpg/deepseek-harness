/**
 * The product variant is read from a typed manifest marker before any path is resolved, and only a
 * variant that owns its own state isolates the Harness home. The release installation keeps resolving
 * exactly as it did, and an explicit `$DSH_HOME` override keeps its documented precedence.
 *
 * The community variant additionally seeds the telemetry mode it installs for itself, because the
 * shared base would otherwise resolve an unset mode to a mode that contacts DeepSeek's collector.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import {
  defaultDshCommunityHome,
  defaultDshDevHome,
  defaultDshHome,
  resolveDshHome,
} from '@deepseek-ai/dsh-home-paths'
import { describe, expect, it } from 'vitest'
import {
  applyDesktopVariantHome,
  applyDesktopVariantTelemetry,
  bootstrapDesktopVariant,
  DESKTOP_COMMUNITY_VARIANT,
  DESKTOP_DEV_VARIANT,
  DESKTOP_PRODUCTION_VARIANT,
  DESKTOP_VARIANT_METADATA,
  readDesktopVariant,
  TELEMETRY_DISABLED_MODE,
  TELEMETRY_MODE_ENV,
} from '../src/desktop-variant.ts'
import { desktopNodeEnvironment } from '../src/node-environment.ts'

/** Resolve the home an environment selects, through the same helper the shell uses. */
function homeOf(env: NodeJS.ProcessEnv): string {
  return resolveDshHome(undefined, env)
}

/** The shared base bundle that every base-backed profile inserts the telemetry row from. */
const basePatch = readFileSync(new URL('../../../packages/bundle/base/cordis.patch.yml', import.meta.url), 'utf8')

describe('desktop variant resolution', () => {
  it('reads a declared variant and defaults to production', () => {
    expect(readDesktopVariant({})).toBe(DESKTOP_PRODUCTION_VARIANT)
    expect(readDesktopVariant({ [DESKTOP_VARIANT_METADATA]: DESKTOP_PRODUCTION_VARIANT })).toBe(DESKTOP_PRODUCTION_VARIANT)
    expect(readDesktopVariant({ [DESKTOP_VARIANT_METADATA]: DESKTOP_DEV_VARIANT })).toBe(DESKTOP_DEV_VARIANT)
    expect(readDesktopVariant({ [DESKTOP_VARIANT_METADATA]: DESKTOP_COMMUNITY_VARIANT })).toBe(DESKTOP_COMMUNITY_VARIANT)
  })

  it('rejects a manifest that is not an object, or declares an unknown variant', () => {
    for (const manifest of [null, undefined, 'production', 7]) {
      expect(() => { readDesktopVariant(manifest) }).toThrow('invalid application manifest')
    }
    // An unknown marker must fail loud: silently reading it as production would drop the isolation.
    expect(() => { readDesktopVariant({ [DESKTOP_VARIANT_METADATA]: 'canary' }) }).toThrow('unsupported')
  })
})

describe('isolated variant home', () => {
  it('leaves production resolving exactly as before and touches nothing', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applyDesktopVariantHome(DESKTOP_PRODUCTION_VARIANT, env)).toBeUndefined()
    expect(env).toEqual({})
    expect(homeOf(env)).toBe(defaultDshHome())
  })

  it('gives a development installation its own home, never the release home', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applyDesktopVariantHome(DESKTOP_DEV_VARIANT, env)).toBe(defaultDshDevHome())
    expect(env.DSH_HOME).toBe(defaultDshDevHome())
    expect(homeOf(env)).toBe(defaultDshDevHome())
    expect(homeOf(env)).not.toBe(defaultDshHome())
    // A sibling of the release home, so a release uninstaller cannot reach it by walking in.
    expect(defaultDshDevHome().startsWith(`${defaultDshHome()}${sep}`)).toBe(false)
  })

  it('gives a community installation a home of its own, disjoint from both other homes', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applyDesktopVariantHome(DESKTOP_COMMUNITY_VARIANT, env)).toBe(defaultDshCommunityHome())
    expect(env.DSH_HOME).toBe(defaultDshCommunityHome())
    expect(homeOf(env)).toBe(defaultDshCommunityHome())
    // The three roots are siblings, so no variant's home is an ancestor of another's — which is what
    // keeps a community uninstaller from deleting a release or development home.
    for (const other of [defaultDshHome(), defaultDshDevHome()]) {
      expect(defaultDshCommunityHome()).not.toBe(other)
      expect(defaultDshCommunityHome().startsWith(`${other}${sep}`)).toBe(false)
      expect(other.startsWith(`${defaultDshCommunityHome()}${sep}`)).toBe(false)
    }
  })

  it('keeps an explicit DSH_HOME, which already outranks the default', () => {
    for (const variant of [DESKTOP_DEV_VARIANT, DESKTOP_COMMUNITY_VARIANT] as const) {
      const env: NodeJS.ProcessEnv = { DSH_HOME: '~/operator-dsh' }
      expect(applyDesktopVariantHome(variant, env)).toBeUndefined()
      expect(env.DSH_HOME).toBe('~/operator-dsh')
      expect(homeOf(env)).toBe(join(homedir(), 'operator-dsh'))
    }
  })

  it('treats a blank DSH_HOME as unset, exactly as resolveDshHome does', () => {
    const env: NodeJS.ProcessEnv = { DSH_HOME: '   ' }
    expect(applyDesktopVariantHome(DESKTOP_DEV_VARIANT, env)).toBe(defaultDshDevHome())
    expect(homeOf(env)).toBe(defaultDshDevHome())
  })
})

describe('community telemetry default', () => {
  it('is what keeps a community build from reaching the shared base collector', () => {
    // The row this variant has to neutralise, read from the bundle that owns it: an unset mode
    // resolves to FEEDBACK_ONLY, whose exporter targets a DeepSeek host. Seeding the mode below is
    // therefore the only thing standing between a community build and that endpoint.
    expect(basePatch).toContain("mode: !!js process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'")
    expect(basePatch).toContain('harness-telemetry.deepseeksvc.com')
    expect(TELEMETRY_MODE_ENV).toBe('DSH_TELEMETRY_MODE')
    expect(TELEMETRY_DISABLED_MODE).not.toBe('FEEDBACK_ONLY')
  })

  it('disables telemetry for a community installation', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applyDesktopVariantTelemetry(DESKTOP_COMMUNITY_VARIANT, env)).toBe(TELEMETRY_DISABLED_MODE)
    expect(env[TELEMETRY_MODE_ENV]).toBe('DISABLED')
  })

  it('leaves a release and a development installation without a telemetry mode', () => {
    // A release keeps its documented behaviour exactly; a development build is not a separate
    // product for telemetry purposes, so only the community variant changes this default.
    for (const variant of [DESKTOP_PRODUCTION_VARIANT, DESKTOP_DEV_VARIANT] as const) {
      const env: NodeJS.ProcessEnv = {}
      expect(applyDesktopVariantTelemetry(variant, env)).toBeUndefined()
      expect(env).toEqual({})
    }
  })

  it('keeps an operator-supplied mode, which outranks the variant default', () => {
    const env: NodeJS.ProcessEnv = { [TELEMETRY_MODE_ENV]: 'FEEDBACK_ONLY' }
    expect(applyDesktopVariantTelemetry(DESKTOP_COMMUNITY_VARIANT, env)).toBeUndefined()
    expect(env[TELEMETRY_MODE_ENV]).toBe('FEEDBACK_ONLY')
  })

  it('treats a blank mode as unset, exactly as the base row does', () => {
    const env: NodeJS.ProcessEnv = { [TELEMETRY_MODE_ENV]: '   ' }
    expect(applyDesktopVariantTelemetry(DESKTOP_COMMUNITY_VARIANT, env)).toBe(TELEMETRY_DISABLED_MODE)
  })
})

describe('desktop variant bootstrap', () => {
  it('reads the packaged manifest and isolates the home before any path is resolved', async () => {
    const env: NodeJS.ProcessEnv = {}
    const reads: string[] = []
    const variant = await bootstrapDesktopVariant({
      appPath: 'desktop-test-app',
      env,
      readManifest: async (path) => {
        reads.push(path)
        return JSON.stringify({ [DESKTOP_VARIANT_METADATA]: DESKTOP_DEV_VARIANT })
      },
    })
    expect(variant).toBe(DESKTOP_DEV_VARIANT)
    expect(reads).toEqual([join('desktop-test-app', 'package.json')])
    expect(env.DSH_HOME).toBe(defaultDshDevHome())
    expect(env[TELEMETRY_MODE_ENV]).toBeUndefined()
  })

  it('isolates both the home and the telemetry default for a community installation', async () => {
    const env: NodeJS.ProcessEnv = {}
    const variant = await bootstrapDesktopVariant({
      appPath: 'desktop-test-app',
      env,
      readManifest: async () => JSON.stringify({ [DESKTOP_VARIANT_METADATA]: DESKTOP_COMMUNITY_VARIANT }),
    })
    expect(variant).toBe(DESKTOP_COMMUNITY_VARIANT)
    // One bootstrap call seeds everything this variant has to own; the Host child process it later
    // spawns inherits this same environment.
    expect(env.DSH_HOME).toBe(defaultDshCommunityHome())
    expect(env[TELEMETRY_MODE_ENV]).toBe(TELEMETRY_DISABLED_MODE)
  })

  it('leaves a production installation without any environment change', async () => {
    const env: NodeJS.ProcessEnv = {}
    const variant = await bootstrapDesktopVariant({
      appPath: 'desktop-test-app', env, readManifest: async () => '{}',
    })
    expect(variant).toBe(DESKTOP_PRODUCTION_VARIANT)
    expect(env).toEqual({})
  })

  it('carries both seeded values into the environment the Host child process is spawned with', async () => {
    // The shell hands the Host its own process environment, and the Host spawn spreads that
    // environment — so composing the two here is what proves the seeded values reach the process that
    // loads the composition, rather than only the shell that seeded them.
    const env: NodeJS.ProcessEnv = { PATH: '/user/bin' }
    await bootstrapDesktopVariant({
      appPath: 'desktop-test-app',
      env,
      readManifest: async () => JSON.stringify({ [DESKTOP_VARIANT_METADATA]: DESKTOP_COMMUNITY_VARIANT }),
    })
    const hostEnvironment = desktopNodeEnvironment('/desktop/electron', undefined, env)
    expect(hostEnvironment).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: defaultDshCommunityHome(),
      [TELEMETRY_MODE_ENV]: TELEMETRY_DISABLED_MODE,
    })
    // The shell's own environment is not mutated by building the child's.
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})
