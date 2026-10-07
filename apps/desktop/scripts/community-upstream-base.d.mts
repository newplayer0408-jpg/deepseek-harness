/** The upstream repository whose tags the fork's declared base names. */
export const OFFICIAL_UPSTREAM_REPOSITORY: 'deepseek-ai/deepseek-harness'

/** That repository's clone URL, the only remote a base tag may be fetched from. */
export const OFFICIAL_UPSTREAM_URL: string

/** An upstream release tag, as upstream names one. */
export const SAFE_UPSTREAM_BASE: RegExp

/**
 * The checkout this module belongs to.
 * @returns Absolute path of the repository root.
 */
export function communityUpstreamRoot(): string

/**
 * Read the upstream base tag the fork declares, if it declares a usable one.
 * @param root - Checkout holding the committed version file.
 * @returns The tag, or undefined when the file is absent, unreadable, or declares another shape.
 */
export function readDeclaredUpstreamBase(root: string): string | undefined

/**
 * Read the declared upstream base, refusing to continue without one.
 * @param root - Checkout holding the committed version file.
 * @returns The tag.
 * @throws When the file cannot be read, or declares a base outside the shape upstream tags have.
 */
export function requireDeclaredUpstreamBase(root: string): string

/** Where one base tag is fetched from, and into which checkout. */
export interface CommunityUpstreamFetchOptions {
  /** Upstream release tag, as declared by the fork. */
  readonly base: string
  /** Repository to fetch from; the official upstream unless a caller names another. */
  readonly repository?: string
  /** Checkout to fetch into; the repository this module belongs to unless a caller names another. */
  readonly cwd?: string
}

/**
 * Fetch exactly one tag from one repository, into the tag namespace of a checkout.
 * @param options - The tag, the checkout to fetch into, and the repository to fetch it from.
 * @returns Nothing; the tag is present in the checkout afterwards.
 * @throws When the tag is outside its shape, or the fetch fails.
 */
export function fetchUpstreamBase(options: CommunityUpstreamFetchOptions): void

/** Which base tag is resolved, and in which checkout. */
export interface CommunityUpstreamResolveOptions {
  /** Upstream release tag, as declared by the fork. */
  readonly base: string
  /** Checkout holding the tag; the repository this module belongs to unless a caller names another. */
  readonly cwd?: string
}

/**
 * Resolve the commit a base tag names, in the checkout that holds it.
 * @param options - The tag and the checkout holding it.
 * @returns The full commit hash.
 * @throws When the tag is outside its shape, absent from the checkout, or does not name a commit.
 */
export function resolveUpstreamCommit(options: CommunityUpstreamResolveOptions): string
