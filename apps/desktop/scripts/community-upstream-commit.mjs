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
 * is a failure, because a published release has to name what it packages. That lane does not read
 * this function: it fetches the tag from upstream first and resolves it strictly through
 * `community-upstream-base.mjs`, which refuses to continue without a commit.
 */

import { execFileSync } from 'node:child_process'
import { readDeclaredUpstreamBase } from './community-upstream-base.mjs'

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

/** A full commit hash, as `git rev-parse` prints one. */
const SAFE_COMMIT = /^[0-9a-f]{40}$/u

/**
 * Resolve the commit the declared upstream base names, in the checkout that declares it.
 *
 * The declared tag is read, and gated, by the module that also fetches it, so the shape a base has to
 * have is spelled once for both the packaging read and the release lane's fetch.
 * @param {string} repositoryRoot - Checkout holding both the version file and the tag it names.
 * @returns {string | undefined} The commit, or undefined when the base or its tag cannot be read.
 */
export function readCommunityUpstreamCommit(repositoryRoot) {
  const base = readDeclaredUpstreamBase(repositoryRoot)
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
