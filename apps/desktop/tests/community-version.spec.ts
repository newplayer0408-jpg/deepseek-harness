/**
 * The fork's version facts live in one committed file, and these cases pin the properties that make it
 * a source of truth: the file parses into a gated identity, a build that is not the community variant
 * reads nothing at all, and a file that is absent, truncated, or edited into something else answers
 * undefined rather than letting its own text reach a surface that renders it.
 *
 * The case that asserts literal values is deliberate. The file records the upstream base this fork is
 * *currently* synced to, and the tempting mistake is to record the base the next sync targets: a
 * metadata file describing a merge that never happened is worse than no metadata at all. That case and
 * the file change together, in the change that performs the sync.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMMUNITY_VERSION_FILE, parseCommunityVersion, readCommunityVersion } from '../src/community-version.ts'
import { DESKTOP_COMMUNITY_VARIANT, DESKTOP_DEV_VARIANT, DESKTOP_PRODUCTION_VARIANT, type DesktopVariant } from '../src/desktop-variant.ts'

/** The application directory, which is where the committed file sits. */
const APP_PATH = fileURLToPath(new URL('../', import.meta.url))

/** A full commit hash, as a case varies one. */
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'

/** A read seam that refuses, so a case can prove the file was never opened at all. */
function refuseToRead(): Promise<string> {
  return Promise.reject(new Error('this case must not read a file'))
}

/** A read seam that answers one literal text, whatever path it is asked for. */
function textFile(text: string): (path: string) => Promise<string> {
  return () => Promise.resolve(text)
}

/** Read whatever one text parses to, the way a build reads the file. */
function readDeclared(text: string, variant: DesktopVariant = DESKTOP_COMMUNITY_VARIANT): Promise<unknown> {
  return readCommunityVersion({ appPath: APP_PATH, variant, read: textFile(text) })
}

/**
 * Plausible field values, varied one at a time.
 *
 * They are deliberately not this fork's own values: a case here exercises the shape gate, and a gate
 * test that fails when the repository is re-synced would be testing the file twice instead of the
 * code once. The file's real contents are asserted where they belong, one case below.
 */
const FIELDS = {
  communityVersion: '9.9-dev',
  upstreamBase: 'dsh-v9.9.9-rc.1',
  upstreamCommit: COMMIT,
} as const

describe('the committed version file', () => {
  it('declares exactly the three facts a community build reports', () => {
    const parsed: unknown = JSON.parse(readFileSync(join(APP_PATH, COMMUNITY_VERSION_FILE), 'utf8'))
    expect(Object.keys(parsed as object).sort()).toEqual(['communityVersion', 'upstreamBase', 'upstreamCommit'])
  })

  it('names the upstream base this fork is synced to today, not the base a later sync targets', () => {
    const parsed: unknown = JSON.parse(readFileSync(join(APP_PATH, COMMUNITY_VERSION_FILE), 'utf8'))
    expect(parsed).toMatchObject({
      upstreamBase: 'dsh-v0.2.0-rc.2',
      upstreamCommit: '639ed015397290b3745d163aafe02ffee4aa3f84',
    })
  })

  it('passes its own gate on disk, and the runtime reader resolves the same identity', async () => {
    const parsed: unknown = JSON.parse(readFileSync(join(APP_PATH, COMMUNITY_VERSION_FILE), 'utf8'))
    const gated = parseCommunityVersion(parsed)
    expect(gated).toBeDefined()
    await expect(readCommunityVersion({ appPath: APP_PATH, variant: DESKTOP_COMMUNITY_VARIANT })).resolves.toEqual(gated)
  })

  it('is named by the contract its three readers share', () => {
    // The shell's reader, the electron-builder file list, and the release workflow each name this
    // file, so one constant is what keeps the three from drifting apart.
    expect(COMMUNITY_VERSION_FILE).toBe('community-version.json')
  })
})

describe('a build that has no community version to report', () => {
  it('reads nothing at all for a variant that is not community, even with the file present', async () => {
    for (const variant of [DESKTOP_PRODUCTION_VARIANT, DESKTOP_DEV_VARIANT] as const) {
      await expect(readCommunityVersion({ appPath: APP_PATH, variant, read: refuseToRead })).resolves.toBeUndefined()
    }
  })

  it('answers undefined, rather than failing a startup, when the file cannot be read', async () => {
    await expect(readCommunityVersion({ appPath: APP_PATH, variant: DESKTOP_COMMUNITY_VARIANT, read: refuseToRead }))
      .resolves.toBeUndefined()
  })

  it('answers undefined when the file is empty, is not JSON, or is JSON of another shape', async () => {
    const unusable = ['', 'community-version.json', 'not json', 'null', '[]', '"0.2-dev"', '{}', '{"communityVersion":"0.2-dev"}']
    for (const text of unusable) await expect(readDeclared(text)).resolves.toBeUndefined()
  })
})

describe('the shape gate every declared fact passes', () => {
  it('renders an accepted version in the user-facing form the file does not carry', () => {
    expect(parseCommunityVersion(FIELDS)).toEqual({
      version: `v${FIELDS.communityVersion}`,
      upstreamBase: FIELDS.upstreamBase,
      upstreamCommit: FIELDS.upstreamCommit,
    })
  })

  it('accepts the version forms a fork release legitimately takes', () => {
    for (const communityVersion of ['1', '0.2', '0.2.1', '1.0.0-dev', '0.2-dev.1']) {
      expect(parseCommunityVersion({ ...FIELDS, communityVersion })?.version).toBe(`v${communityVersion}`)
    }
  })

  it('refuses a community version that is not one, including the display form the file must not hold', () => {
    const refused = ['', `v${FIELDS.communityVersion}`, '9.9-dev\n9.9', 'latest', 'sk-test-THIS-MUST-NOT-LEAK',
      'C:\\Users\\secret-user', '9.9.9.9.9.9', '9.9-dev-']
    for (const communityVersion of refused) {
      expect(parseCommunityVersion({ ...FIELDS, communityVersion })).toBeUndefined()
    }
  })

  it('refuses an upstream base that is not one of upstream\'s tags', () => {
    const refused = ['', 'v9.9.9-rc.1', '9.9.9-rc.1', 'dsh-9.9.9-rc.1', 'dsh-v', 'dsh-v9.9.9-rc.1\nx',
      'C:\\Users\\secret-user']
    for (const upstreamBase of refused) {
      expect(parseCommunityVersion({ ...FIELDS, upstreamBase })).toBeUndefined()
    }
  })

  it('refuses a commit that is not a full lowercase hash, so the base stays reproducible', () => {
    const refused = ['', COMMIT.slice(0, 8), COMMIT.toUpperCase(), 'z'.repeat(40), `${COMMIT}0`,
      'Bearer super-secret-token']
    for (const upstreamCommit of refused) {
      expect(parseCommunityVersion({ ...FIELDS, upstreamCommit })).toBeUndefined()
    }
  })

  it('refuses a value of the wrong kind, and anything that is not an object at all', () => {
    const refused: unknown[] = [
      { ...FIELDS, communityVersion: 2 },
      { ...FIELDS, upstreamBase: null },
      { ...FIELDS, upstreamCommit: 42 },
      {},
      null,
      undefined,
      [],
      'community-version.json',
      COMMIT,
    ]
    for (const source of refused) expect(parseCommunityVersion(source)).toBeUndefined()
  })
})
