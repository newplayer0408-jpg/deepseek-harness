/**
 * The renderer argument that marks a Community build, and nothing else.
 *
 * This module is deliberately dependency-free, and that is a build constraint rather than a style
 * preference. A sandboxed preload imports it, and a preload's `require` polyfill resolves only
 * `electron`, `events`, `timers`, and `url` — so a value import of the variant module would not
 * merely bloat the preload, it would fail the bundle: `scripts/desktop-bundle-imports.mjs` walks
 * every parsed module before tree-shaking, and the variant module reaches `node:fs/promises`,
 * `node:path`, and the home resolver. The marker is therefore spelled here, on the same terms the
 * diagnostics channels are spelled beside their own window.
 */

/** Prefix Electron appends to every renderer argument the shell passes through. */
export const DESKTOP_VARIANT_ARGUMENT_PREFIX = '--dsh-desktop-variant='

/**
 * The one argument a Community build passes to its preload.
 *
 * A release and a development build pass nothing, so this marker is the only string the preload side
 * has to recognize and the release path stays byte-identical.
 */
export const COMMUNITY_VARIANT_ARGUMENT = `${DESKTOP_VARIANT_ARGUMENT_PREFIX}community`

/**
 * Renderer arguments one build needs its preload to read.
 * @param community - whether the assembled manifest declared the community variant.
 * @returns the arguments to append, empty for every other build.
 */
export function communityVariantArguments(community: boolean): string[] {
  return community ? [COMMUNITY_VARIANT_ARGUMENT] : []
}

/**
 * Whether a renderer belongs to a Community build.
 * @param argv - the renderer process arguments a preload observes.
 * @returns whether the community marker is present.
 */
export function isCommunityArguments(argv: readonly string[]): boolean {
  return argv.includes(COMMUNITY_VARIANT_ARGUMENT)
}
