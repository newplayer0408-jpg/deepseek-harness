/**
 * Derive the commit the fork's declared upstream base names, so a build can record it without the
 * repository committing the hash itself.
 *
 * The fork declares the upstream tag it was synced to in `apps/desktop/community-version.json`, and
 * a tag is a reference upstream maintains. The commit behind it is not: writing one into a tracked
 * file creates a repository reference that drifts the moment the tag moves or the history is
 * rewritten, which is exactly what `scripts/verify-repository-references.ts` rejects. So the tag
 * stays committed and the commit is derived here, at packaging time, from the checkout that holds
 * both — then carried into the assembled manifest the running application reads, the same way the
 * build commit beside it is.
 *
 * Resolution is best effort by design. A checkout without the tag — a shallow clone, or a fork that
 * has never fetched upstream's tags — answers undefined, and the build is packaged without a commit
 * rather than with an invented one. Nothing here fails a packaging run: the application reports the
 * base it knows and omits the commit it does not, and the fork's release lane is where a missing tag
 * is a failure, because a published release has to name what it packages.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Assembled-manifest field that carries the resolved commit to the application runtime.
 *
 * `src/community-version.ts` declares the same field name for the reader. The two layers own their
 * own spelling for the same reason `dshDesktopVariant` is spelled in both: a build script cannot
 * import the bundled application source.
 */
export const UPSTREAM_COMMIT_METADATA = 'dshUpstreamCommit'

/** Environment variable that carries the resolved commit through one packaging run. */
export const UPSTREAM_COMMIT_ENV = 'DSH_DESKTOP_UPSTREAM_COMMIT'

/** The committed file that declares the fork's version facts, relative to the repository root. */
const VERSION_FILE = join('apps', 'desktop', 'community-version.json')

/** An upstream release tag, as upstream names one. */
const SAFE_UPSTREAM_BASE = /^dsh-v\d{1,4}(?:\.\d{1,5}){0,2}(?:-[A-Za-z0-9.]{1,32})?$/u

/** A full commit hash, as `git rev-parse` prints one. */
const SAFE_COMMIT = /^[0-9a-f]{40}$/u

/**
 * Read the upstream base tag the fork declares.
 *
 * The tag is gated before it reaches a Git command line, so a hand-edited file cannot turn its own
 * contents into arguments.
 * @param {string} repositoryRoot - Checkout holding the application.
 * @returns {string | undefined} The tag, or undefined when the file is absent or declares none.
 */
function declaredUpstreamBase(repositoryRoot) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(repositoryRoot, VERSION_FILE), 'utf8'))
  } catch {
    return undefined
  }
  const base = parsed?.upstreamBase
  return typeof base === 'string' && SAFE_UPSTREAM_BASE.test(base) ? base : undefined
}

/**
 * Resolve the commit the declared upstream base names, in the checkout that declares it.
 * @param {string} repositoryRoot - Checkout holding both the version file and the tag it names.
 * @returns {string | undefined} The commit, or undefined when the base or its tag cannot be read.
 */
export function readCommunityUpstreamCommit(repositoryRoot) {
  const base = declaredUpstreamBase(repositoryRoot)
  if (base === undefined) return undefined
  let commit
  try {
    commit = execFileSync('git', ['rev-list', '-n', '1', base], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
  return SAFE_COMMIT.test(commit) ? commit : undefined
}

/**
 * Read the commit a parent packaging process resolved.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {string | undefined} The commit, or undefined outside a packaging run that recorded one.
 */
export function resolveCommunityUpstreamCommit(env) {
  const commit = env[UPSTREAM_COMMIT_ENV]?.trim()
  if (commit === undefined || commit === '') return undefined
  if (!SAFE_COMMIT.test(commit)) {
    throw new Error(`community upstream commit: ${UPSTREAM_COMMIT_ENV} must be a commit hash`)
  }
  return commit
}

/**
 * Describe the resolved commit as the environment variable child processes read.
 * @param {string | undefined} commit - Commit a packaging run resolved, if it resolved one.
 * @returns {Record<string, string>} Variables to merge into a child environment; empty when none.
 */
export function communityUpstreamCommitEnvironment(commit) {
  return commit === undefined ? {} : { [UPSTREAM_COMMIT_ENV]: commit }
}
