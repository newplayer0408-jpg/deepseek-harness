/**
 * The product variant is read from a typed manifest marker before any path is resolved, and only a
 * declared development variant isolates the Harness home. The release installation keeps resolving
 * exactly as it did, and an explicit `$DSH_HOME` override keeps its documented precedence.
 */
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { defaultDshDevHome, defaultDshHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { describe, expect, it } from 'vitest'
import {
  applyDesktopVariantHome,
  bootstrapDesktopVariant,
  DESKTOP_DEV_VARIANT,
  DESKTOP_PRODUCTION_VARIANT,
  DESKTOP_VARIANT_METADATA,
  readDesktopVariant,
} from '../src/desktop-variant.ts'

/** Resolve the home an environment selects, through the same helper the shell uses. */
function homeOf(env: NodeJS.ProcessEnv): string {
  return resolveDshHome(undefined, env)
}

describe('desktop variant resolution', () => {
  it('reads a declared variant and defaults to production', () => {
    expect(readDesktopVariant({})).toBe(DESKTOP_PRODUCTION_VARIANT)
    expect(readDesktopVariant({ [DESKTOP_VARIANT_METADATA]: DESKTOP_PRODUCTION_VARIANT })).toBe(DESKTOP_PRODUCTION_VARIANT)
    expect(readDesktopVariant({ [DESKTOP_VARIANT_METADATA]: DESKTOP_DEV_VARIANT })).toBe(DESKTOP_DEV_VARIANT)
  })

  it('rejects a manifest that is not an object, or declares an unknown variant', () => {
    for (const manifest of [null, undefined, 'production', 7]) {
      expect(() => { readDesktopVariant(manifest) }).toThrow('invalid application manifest')
    }
    // An unknown marker must fail loud: silently reading it as production would drop the isolation.
    expect(() => { readDesktopVariant({ [DESKTOP_VARIANT_METADATA]: 'canary' }) }).toThrow('unsupported')
  })
})

describe('development home isolation', () => {
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

  it('keeps an explicit DSH_HOME, which already outranks the default', () => {
    const env: NodeJS.ProcessEnv = { DSH_HOME: '~/operator-dsh' }
    expect(applyDesktopVariantHome(DESKTOP_DEV_VARIANT, env)).toBeUndefined()
    expect(env.DSH_HOME).toBe('~/operator-dsh')
    expect(homeOf(env)).toBe(join(homedir(), 'operator-dsh'))
  })

  it('treats a blank DSH_HOME as unset, exactly as resolveDshHome does', () => {
    const env: NodeJS.ProcessEnv = { DSH_HOME: '   ' }
    expect(applyDesktopVariantHome(DESKTOP_DEV_VARIANT, env)).toBe(defaultDshDevHome())
    expect(homeOf(env)).toBe(defaultDshDevHome())
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
  })

  it('leaves a production installation without any environment change', async () => {
    const env: NodeJS.ProcessEnv = {}
    const variant = await bootstrapDesktopVariant({
      appPath: 'desktop-test-app', env, readManifest: async () => '{}',
    })
    expect(variant).toBe(DESKTOP_PRODUCTION_VARIANT)
    expect(env).toEqual({})
  })
})
