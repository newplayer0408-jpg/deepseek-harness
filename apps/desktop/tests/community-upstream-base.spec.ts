/**
 * The release lane has to name the upstream commit it publishes under, and the checkout it runs in
 * cannot answer that: a fork does not inherit upstream's tags, so the tag the version file names is
 * simply absent from a runner's clone. These cases build that situation instead of describing it — a
 * repository playing upstream, a clone of it that holds the commits and no tags, and the fetch the
 * lane performs in between — so what is under test is that the tag becomes resolvable, rather than
 * that some command appears in a file.
 *
 * The tag rule and the fetch destination are checked here as values and as behaviour: the rule is the
 * one the committed file is read with, and the destination is a constant, so neither the file nor a
 * caller can move the lane onto another repository.
 *
 * The upstream fixture is built once and only read afterwards — each case clones it — because every
 * Git invocation costs real time on a hosted runner and six cases each assembling their own upstream
 * would spend most of the file's budget on fixture setup.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  OFFICIAL_UPSTREAM_REPOSITORY,
  OFFICIAL_UPSTREAM_URL,
  SAFE_UPSTREAM_BASE,
  communityUpstreamRoot,
  fetchUpstreamBase,
  readDeclaredUpstreamBase,
  requireDeclaredUpstreamBase,
  resolveUpstreamCommit,
} from '../scripts/community-upstream-base.mjs'
import { COMMUNITY_VERSION_FILE } from '../src/community-version.ts'

/** The checkout this repository is in. */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** The helper as the release lane invokes it. */
const HELPER = join(REPOSITORY_ROOT, 'apps', 'desktop', 'scripts', 'community-upstream-base.mjs')

/** The tag the fixtures publish, spelled as upstream spells one. */
const BASE = 'dsh-v0.2.0-rc.2'

/** A second tag, so a case can prove the fetch brings only the one it was asked for. */
const OTHER = 'dsh-v9.9.9'

/** A commit identity, so a fixture commit does not depend on the machine's Git configuration. */
const IDENTITY = ['-c', 'user.name=community release test', '-c', 'user.email=community-release@example.invalid']

/** Every temporary directory the file created, removed as it goes. */
const roots: string[] = []

/** The fixture repository playing upstream, and the commit its base tag names. */
let upstream = ''
let upstreamCommit = ''

beforeAll(async () => {
  const bare = join(await temporaryRoot('dsh-upstream-official-'), 'official.git')
  const work = join(await temporaryRoot('dsh-upstream-work-'), 'work')
  await mkdir(bare, { recursive: true })
  await mkdir(work, { recursive: true })
  git(work, ['init', '--quiet', '--initial-branch=main'])
  git(work, [...IDENTITY, 'commit', '--quiet', '--allow-empty', '-m', 'the commit a release is based on'])
  git(work, ['tag', BASE])
  git(work, ['tag', OTHER])
  git(bare, ['init', '--quiet', '--bare'])
  // Point the fixture's HEAD at the branch it will hold, so a clone checks that branch out.
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(work, ['remote', 'add', 'official', bare])
  git(work, ['push', '--quiet', 'official', 'main', `refs/tags/${BASE}`, `refs/tags/${OTHER}`])
  upstreamCommit = commitHash(git(work, ['rev-parse', `${BASE}^{commit}`]))
  upstream = bare
}, 60_000)

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A temporary directory that is removed after the case that asked for it. */
async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** Run one Git command and return its trimmed standard output. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** One commit hash, read out of whatever Git printed. */
function commitHash(value: string): string {
  const match = /^[0-9a-f]{40}$/u.exec(value)
  if (match === null) throw new Error(`expected a commit hash, read ${JSON.stringify(value)}`)
  return match[0]
}

/** Whether one ref resolves in a checkout. */
function holds(checkout: string, ref: string): boolean {
  try {
    git(checkout, ['rev-parse', '--verify', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

/**
 * A clone of the fixture upstream that is what a runner starts with: every commit is there and no tag
 * is, which is the state the release lane has to get out of.
 * @returns Path of the checkout.
 */
async function taglessCheckout(): Promise<string> {
  const checkout = join(await temporaryRoot('dsh-clone-'), 'checkout')
  git(tmpdir(), ['clone', '--quiet', '--no-tags', upstream, checkout])
  return checkout
}

/** Run the helper the way the workflow does, and collect what it said. */
function runHelper(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [HELPER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}

describe('reading the declared upstream base', () => {
  it('finds the committed file from this module\'s own location, whatever the working directory is', () => {
    const declared = (JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'apps', 'desktop', COMMUNITY_VERSION_FILE), 'utf8')) as {
      upstreamBase: string
    }).upstreamBase
    // The helper resolves the checkout from its own URL rather than from the process's directory,
    // because a package script runs in the package directory while the release steps run at the root.
    expect(readDeclaredUpstreamBase(communityUpstreamRoot())).toBe(declared)
    expect(requireDeclaredUpstreamBase(REPOSITORY_ROOT)).toBe(declared)
    expect(SAFE_UPSTREAM_BASE.test(declared)).toBe(true)
    expect(SAFE_UPSTREAM_BASE.test(BASE)).toBe(true)
  })

  it('reads no base at all out of a file that declares none, or declares one upstream could not have', async () => {
    const unusable = [
      '{}',
      'not json',
      JSON.stringify({ upstreamBase: 'main' }),
      JSON.stringify({ upstreamBase: 'refs/heads/main' }),
      JSON.stringify({ upstreamBase: ' dsh-v0.2.0-rc.2' }),
      JSON.stringify({ upstreamBase: `${BASE}\n--upload-pack=touch` }),
      JSON.stringify({ upstreamBase: 'https://github.com/deepseek-ai/deepseek-harness.git' }),
      JSON.stringify({ upstreamBase: { tag: BASE } }),
    ]
    for (const contents of unusable) {
      const root = join(await temporaryRoot('dsh-declared-'), 'checkout')
      await mkdir(join(root, 'apps', 'desktop'), { recursive: true })
      await writeFile(join(root, 'apps', 'desktop', COMMUNITY_VERSION_FILE), contents)
      expect(readDeclaredUpstreamBase(root), contents).toBeUndefined()
      expect(() => requireDeclaredUpstreamBase(root)).toThrow(/unusable upstreamBase/u)
    }
    const empty = await temporaryRoot('dsh-declared-empty-')
    expect(readDeclaredUpstreamBase(empty)).toBeUndefined()
    expect(() => requireDeclaredUpstreamBase(empty)).toThrow(/unusable upstreamBase/u)
  })
})

describe('fetching the declared upstream base', () => {
  it('cannot resolve a base the checkout does not hold, which is the state a runner starts in', async () => {
    const checkout = await taglessCheckout()
    expect(holds(checkout, BASE)).toBe(false)
    expect(() => resolveUpstreamCommit({ base: BASE, cwd: checkout })).toThrow(/is not a commit/u)
  }, 30_000)

  it('fetches exactly the declared tag, and resolves the commit upstream published it at', async () => {
    const checkout = await taglessCheckout()
    fetchUpstreamBase({ base: BASE, repository: upstream, cwd: checkout })
    expect(git(checkout, ['rev-parse', `${BASE}^{commit}`])).toBe(upstreamCommit)
    expect(resolveUpstreamCommit({ base: BASE, cwd: checkout })).toBe(upstreamCommit)
    // `--no-tags` plus one refspec: the checkout gains the tag it asked for and nothing else, rather
    // than upstream's whole tag namespace.
    expect(holds(checkout, OTHER)).toBe(false)
  }, 30_000)

  it('leaves a tag that already agrees with upstream alone, so a rerun of one release is idempotent', async () => {
    const checkout = await taglessCheckout()
    fetchUpstreamBase({ base: BASE, repository: upstream, cwd: checkout })
    fetchUpstreamBase({ base: BASE, repository: upstream, cwd: checkout })
    expect(resolveUpstreamCommit({ base: BASE, cwd: checkout })).toBe(upstreamCommit)
  }, 30_000)

  it('refuses to move a tag the checkout holds at another commit, rather than overwriting it', async () => {
    const checkout = await taglessCheckout()
    // A base that has moved under a release is a fact for an operator to see, so this lane never
    // passes `--force`: Git refuses to update an existing tag, and that refusal is the outcome here.
    git(checkout, [...IDENTITY, 'commit', '--quiet', '--allow-empty', '-m', 'a commit upstream never saw'])
    git(checkout, ['tag', BASE])
    const local = commitHash(git(checkout, ['rev-parse', `${BASE}^{commit}`]))
    expect(local).not.toBe(upstreamCommit)
    expect(() => fetchUpstreamBase({ base: BASE, repository: upstream, cwd: checkout })).toThrow(/could not fetch/u)
    // The tag the lane was asked to move is exactly where it was.
    expect(git(checkout, ['rev-parse', `${BASE}^{commit}`])).toBe(local)
  }, 30_000)

  it('refuses a base that is not an upstream release tag before reaching Git at all', async () => {
    const checkout = await taglessCheckout()
    const missing = join(await temporaryRoot('dsh-no-repository-'), 'absent.git')
    for (const base of ['', 'main', 'refs/heads/main', `${BASE} `, `${BASE}\n--upload-pack=touch`, `${BASE}^{commit}`]) {
      // A value outside the shape is refused by the rule, not by a failing Git call: pointing the fetch
      // at a repository that does not exist would report a fetch error instead of this one.
      expect(() => fetchUpstreamBase({ base, repository: missing, cwd: checkout }), JSON.stringify(base))
        .toThrow(/not an upstream release tag/u)
      expect(() => resolveUpstreamCommit({ base, cwd: checkout }), JSON.stringify(base))
        .toThrow(/not an upstream release tag/u)
    }
  }, 30_000)
})

describe('the repository a base may be fetched from', () => {
  it('names the official upstream project, in the one place a destination is decided', () => {
    expect(OFFICIAL_UPSTREAM_REPOSITORY).toBe('deepseek-ai/deepseek-harness')
    expect(OFFICIAL_UPSTREAM_URL).toBe(`https://github.com/${OFFICIAL_UPSTREAM_REPOSITORY}.git`)
    // One URL in the module: the constant. A second would be a second destination.
    const source = readFileSync(HELPER, 'utf8')
    expect([...source.matchAll(/https?:\/\//gu)]).toHaveLength(1)
  })

  it('takes no repository from the caller, so no data file can redirect the fetch', () => {
    for (const args of [
      [],
      ['--repository=https://example.invalid/deepseek-harness.git'],
      ['fetch', '--repository', 'https://example.invalid/deepseek-harness.git'],
      ['fetch', 'extra'],
    ]) {
      const result = runHelper(args)
      expect(result.status, args.join(' ')).not.toBe(0)
      expect(result.stderr).toContain('usage:')
    }
    // The phase the lane does run answers with the declared base, and nothing else.
    const validated = runHelper(['validate'])
    expect(validated.status).toBe(0)
    expect(validated.stdout.trim()).toBe(readDeclaredUpstreamBase(communityUpstreamRoot()))
  })
})
