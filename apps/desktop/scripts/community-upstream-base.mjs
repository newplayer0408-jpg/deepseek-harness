/**
 * Fetch the upstream base this fork declares, from the repository that owns it.
 *
 * The fork records the upstream tag it was synced to in `apps/desktop/community-version.json`, and
 * the release lane has to turn that tag into the commit it publishes under. A checkout of the fork
 * cannot answer that by itself: tags are not inherited by a fork, so the tag the file names exists
 * only where upstream published it, or in a developer's checkout that added upstream as a remote and
 * fetched it. A release lane that read the tag out of the checkout therefore passed on every machine
 * that had upstream configured and failed on the first runner that did not.
 *
 * So the tag is fetched, exactly, from the repository that owns it, and resolved there. Two
 * properties are what make that safe rather than merely convenient. The repository is a constant in
 * this module, so neither the version file nor anything the calling workflow is handed can move the
 * fetch onto another host — the file supplies a tag and nothing else. And the refspec names one tag,
 * so nothing else is fetched: `--no-tags` is what keeps a release run from pulling upstream's whole
 * tag namespace into a checkout that never asked for it.
 *
 * The tag is the only value that crosses into a Git command line, and it is gated before it does, so
 * a hand-edited file cannot turn its own contents into arguments or into a revision expression.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * The upstream repository whose tags the fork's declared base names.
 *
 * This is the one place the fetch destination is decided. It is deliberately not read from
 * `community-version.json`, from a workflow input, or from the checkout's own remotes: a published
 * release has to be based on the upstream project itself, and a value that a data file could supply
 * is a value that could point the lane somewhere nobody reviewed.
 */
export const OFFICIAL_UPSTREAM_REPOSITORY = 'deepseek-ai/deepseek-harness'

/** That repository's clone URL, the only remote a base tag may be fetched from. */
export const OFFICIAL_UPSTREAM_URL = `https://github.com/${OFFICIAL_UPSTREAM_REPOSITORY}.git`

/**
 * An upstream release tag, as upstream names one.
 *
 * Upstream publishes `dsh-v<major>[.<minor>[.<patch>]][-<prerelease>]`, and the fork's base is always
 * one of those tags. The shape is anchored and every character in it is drawn from that grammar, so
 * a value carrying a space, a shell metacharacter, a `refs/heads/*` pattern, a URL, or a revision
 * expression such as `main~1` is refused rather than handed to Git.
 */
export const SAFE_UPSTREAM_BASE = /^dsh-v\d{1,4}(?:\.\d{1,5}){0,2}(?:-[A-Za-z0-9.]{1,32})?$/u

/** A full commit hash, as `git rev-parse` prints one. */
const SAFE_COMMIT = /^[0-9a-f]{40}$/u

/** The committed file that declares the fork's version facts, relative to the repository root. */
const VERSION_FILE = join('apps', 'desktop', 'community-version.json')

/** What the command line accepts, and the whole of what it accepts. */
const USAGE = 'usage: community-upstream-base.mjs <validate|fetch|resolve>'

/**
 * The checkout this module belongs to.
 *
 * Derived from this file's own URL rather than from the working directory, because a package script
 * runs in the package directory while the steps that call this run at the workspace root.
 * @returns Absolute path of the repository root.
 */
export function communityUpstreamRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url))
}

/**
 * Read the upstream base tag the fork declares, if it declares a usable one.
 * @param root - Checkout holding the committed version file.
 * @returns The tag, or undefined when the file is absent, unreadable, or declares another shape.
 */
export function readDeclaredUpstreamBase(root) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(root, VERSION_FILE), 'utf8'))
  } catch {
    return undefined
  }
  const base = parsed?.upstreamBase
  return typeof base === 'string' && SAFE_UPSTREAM_BASE.test(base) ? base : undefined
}

/**
 * Read the declared upstream base, refusing to continue without one.
 *
 * The refusal is the point: a release has to name the upstream commit it was built on, and inventing
 * one — or silently skipping the fact — would publish a release that cannot be traced back.
 * @param root - Checkout holding the committed version file.
 * @returns The tag.
 * @throws When the file cannot be read, or declares a base outside the shape upstream tags have.
 */
export function requireDeclaredUpstreamBase(root) {
  const base = readDeclaredUpstreamBase(root)
  if (base === undefined) {
    throw new Error(`${VERSION_FILE} declares an unusable upstreamBase; a Community release fetches the tag it names from upstream`)
  }
  return base
}

/**
 * Fetch exactly one tag from one repository, into the tag namespace of a checkout.
 *
 * A tag that the checkout already holds and that agrees with upstream is left alone: Git answers an
 * unchanged refspec without error, so a rerun of the same release is idempotent. A tag the checkout
 * holds at a *different* commit is refused by Git rather than overwritten — deliberately without
 * `--force`, because a base that has moved under a release is a fact an operator has to see, not one
 * to paper over by moving the local tag to match.
 * @param options - The tag, the checkout to fetch into, and the repository to fetch it from.
 * @returns Nothing; the tag is present in the checkout afterwards.
 * @throws When the tag is outside its shape, or the fetch fails.
 */
export function fetchUpstreamBase(options) {
  const base = options.base
  if (!SAFE_UPSTREAM_BASE.test(base)) {
    throw new Error(`community upstream base: refusing to fetch '${base}', which is not an upstream release tag`)
  }
  const repository = options.repository ?? OFFICIAL_UPSTREAM_URL
  const ref = `refs/tags/${base}`
  try {
    execFileSync('git', ['fetch', '--no-tags', repository, `${ref}:${ref}`], {
      cwd: options.cwd ?? communityUpstreamRoot(),
      encoding: 'utf8',
      // An explicit stdio: the fetch inherits nothing from the parent process, so no terminal, no
      // credentials prompt, and no inherited descriptor decides whether this call can complete.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new Error(`community upstream base: could not fetch ${base} from ${repository}`, { cause: error })
  }
}

/**
 * Resolve the commit a base tag names, in the checkout that holds it.
 *
 * The value is peeled to a commit, so an annotated tag answers with the commit it points at rather
 * than with the tag object, and the result is checked against the shape a full hash has before it is
 * handed to anything that would record it.
 * @param options - The tag and the checkout holding it.
 * @returns The full commit hash.
 * @throws When the tag is outside its shape, absent from the checkout, or does not name a commit.
 */
export function resolveUpstreamCommit(options) {
  const base = options.base
  if (!SAFE_UPSTREAM_BASE.test(base)) {
    throw new Error(`community upstream base: refusing to resolve '${base}', which is not an upstream release tag`)
  }
  const cwd = options.cwd ?? communityUpstreamRoot()
  let commit
  try {
    commit = execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    throw new Error(`community upstream base: ${base} is not a commit in ${cwd}`, { cause: error })
  }
  if (!SAFE_COMMIT.test(commit)) {
    throw new Error(`community upstream base: ${base} resolved to ${commit}, which is not a commit hash`)
  }
  return commit
}

/**
 * Run one phase of the fetch the release lane performs.
 *
 * The phases are separate commands rather than one, because a release run has to be able to say which
 * of them failed: reading a declaration that cannot be used, reaching upstream, and resolving the
 * commit are three different problems with three different remedies. Each phase re-reads and
 * re-validates the tag, so invoking one of them on its own is no less safe than the whole sequence.
 * @param argv - Arguments after the script name.
 * @returns Nothing; the phase writes its result to standard output.
 */
function main(argv) {
  const [phase, ...rest] = argv
  if (rest.length > 0 || (phase !== 'validate' && phase !== 'fetch' && phase !== 'resolve')) {
    process.stderr.write(`${USAGE}\n`)
    process.exitCode = 1
    return
  }
  const root = communityUpstreamRoot()
  const base = requireDeclaredUpstreamBase(root)
  if (phase === 'validate') {
    process.stdout.write(`${base}\n`)
    return
  }
  if (phase === 'fetch') {
    fetchUpstreamBase({ base })
    process.stdout.write(`fetched ${base} from ${OFFICIAL_UPSTREAM_REPOSITORY}\n`)
    return
  }
  process.stdout.write(`${resolveUpstreamCommit({ base })}\n`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
