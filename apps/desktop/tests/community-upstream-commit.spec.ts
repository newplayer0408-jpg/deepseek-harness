/**
 * The commit behind the fork's declared upstream base is derived, never committed, and these cases pin
 * both ends of that: the resolver reads the tag out of the checkout that declares it, and the value a
 * packaging run hands to its children round-trips unchanged. A checkout that cannot answer resolves
 * nothing rather than a stale or invented hash, which is what keeps a shallow clone from packaging a
 * commit it does not hold.
 *
 * The read is exercised against this repository and against temporary roots, so no case pins a hash:
 * the assertion on a resolved commit is its shape, and the tag it came from is the file's own.
 */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  UPSTREAM_COMMIT_ENV,
  UPSTREAM_COMMIT_METADATA,
  communityUpstreamCommitEnvironment,
  readCommunityUpstreamCommit,
  resolveCommunityUpstreamCommit,
} from '../scripts/community-upstream-commit.mjs'
import { COMMUNITY_VERSION_FILE, UPSTREAM_COMMIT_METADATA as READER_METADATA } from '../src/community-version.ts'

/** The checkout this repository is in, which holds both the version file and the tag it declares. */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** The committed version file, as the resolver and the release workflow read it. */
const VERSION_FILE = join(REPOSITORY_ROOT, 'apps', 'desktop', COMMUNITY_VERSION_FILE)

/** A commit a packaging run could have resolved: shaped like one, and belonging to no repository object. */
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A root that declares one version file — and is not a checkout, so its tag can never resolve. */
async function declaredRoot(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-upstream-commit-'))
  roots.push(root)
  const directory = join(root, 'apps', 'desktop')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, COMMUNITY_VERSION_FILE), contents)
  return root
}

describe('reading the declared upstream base', () => {
  it('resolves the commit the base tag names in this checkout', () => {
    expect(readCommunityUpstreamCommit(REPOSITORY_ROOT)).toMatch(/^[0-9a-f]{40}$/u)
  })

  it('names a tag, and records no hash for the resolver to prefer over it', () => {
    const declared: unknown = JSON.parse(readFileSync(VERSION_FILE, 'utf8'))
    const fields = declared as Record<string, unknown>
    expect(fields.upstreamBase).toMatch(/^dsh-v\d/u)
    expect(fields).not.toHaveProperty('upstreamCommit')
    expect(fields).not.toHaveProperty(UPSTREAM_COMMIT_METADATA)
  })

  it('resolves nothing when the declared tag is not in the checkout', async () => {
    expect(readCommunityUpstreamCommit(await declaredRoot('{"communityVersion":"0.2-dev","upstreamBase":"dsh-v9.9.9-rc.1"}')))
      .toBeUndefined()
  })

  it('resolves nothing for a base that is not a tag, so a hand-edited file reaches no command', async () => {
    const unusable = ['', '--upload-pack=touch', 'dsh-v1.0.0-rc.1\n--exec', 'main', 'v1.0.0-rc.1']
    for (const upstreamBase of unusable) {
      const root = await declaredRoot(JSON.stringify({ communityVersion: '0.2-dev', upstreamBase }))
      expect(readCommunityUpstreamCommit(root)).toBeUndefined()
    }
  })

  it('resolves nothing when the checkout declares no version file, or no base in it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upstream-commit-'))
    roots.push(root)
    expect(readCommunityUpstreamCommit(root)).toBeUndefined()
    expect(readCommunityUpstreamCommit(await declaredRoot('{}'))).toBeUndefined()
    expect(readCommunityUpstreamCommit(await declaredRoot('not json'))).toBeUndefined()
    expect(readCommunityUpstreamCommit(await declaredRoot('{"communityVersion":"0.2-dev"}'))).toBeUndefined()
  })
})

describe('carrying the resolved commit through a packaging run', () => {
  it('reads nothing outside a run that resolved one', () => {
    expect(resolveCommunityUpstreamCommit({})).toBeUndefined()
    expect(resolveCommunityUpstreamCommit({ [UPSTREAM_COMMIT_ENV]: '  ' })).toBeUndefined()
    expect(communityUpstreamCommitEnvironment(undefined)).toEqual({})
  })

  it('round-trips a resolved commit through a child environment', () => {
    expect(communityUpstreamCommitEnvironment(COMMIT)).toEqual({ [UPSTREAM_COMMIT_ENV]: COMMIT })
    expect(resolveCommunityUpstreamCommit(communityUpstreamCommitEnvironment(COMMIT))).toBe(COMMIT)
  })

  it.each(['abc', `${COMMIT}0`, COMMIT.toUpperCase(), 'Z'.repeat(40)])('rejects %j, which is not a commit hash', (commit) => {
    expect(() => resolveCommunityUpstreamCommit({ [UPSTREAM_COMMIT_ENV]: commit }))
      .toThrow(/must be a commit hash/u)
  })

  it('names the manifest field the reader on the other side of the boundary reads', () => {
    // A build script cannot import the bundled application source, so the two layers spell the field
    // twice; this is the case that keeps the two spellings from drifting apart.
    expect(UPSTREAM_COMMIT_METADATA).toBe(READER_METADATA)
  })
})
