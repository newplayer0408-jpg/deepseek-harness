/** Assembled-manifest field that carries the resolved upstream commit to the application runtime. */
export const UPSTREAM_COMMIT_METADATA: 'dshUpstreamCommit'

/** Environment variable that carries the resolved upstream commit through one packaging run. */
export const UPSTREAM_COMMIT_ENV: 'DSH_DESKTOP_UPSTREAM_COMMIT'

/**
 * Resolve the commit the declared upstream base names, in the checkout that declares it.
 * @param repositoryRoot - Checkout holding both the version file and the tag it names.
 * @returns The commit, or undefined when the base or its tag cannot be read.
 */
export function readCommunityUpstreamCommit(repositoryRoot: string): string | undefined

/**
 * Read the commit a parent packaging process resolved.
 * @param env - Packaging environment.
 * @returns The commit, or undefined outside a packaging run that recorded one.
 */
export function resolveCommunityUpstreamCommit(env: NodeJS.ProcessEnv): string | undefined

/**
 * Describe the resolved commit as the environment variable child processes read.
 * @param commit - Commit a packaging run resolved, if it resolved one.
 * @returns Variables to merge into a child environment; empty when none.
 */
export function communityUpstreamCommitEnvironment(commit: string | undefined): Record<string, string>
