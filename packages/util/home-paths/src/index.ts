/**
 * Shared filesystem path helpers for DeepSeek Harness user data.
 *
 * @module @deepseek-ai/dsh-home-paths
 */

import { opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Directory name for the default DeepSeek Harness home under the OS home. */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Stable user-facing display form for the default DeepSeek Harness home. */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${DSH_HOME_DIR_NAME}`

/** Environment variable that overrides the default DeepSeek Harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * Directory name for the isolated home a development build uses.
 *
 * A development build is a separate product installation, so it must not read
 * or write the home a release installation owns.
 */
export const DSH_DEV_HOME_DIR_NAME = '.dsh-dev'

/** Stable user-facing display form for the development DeepSeek Harness home. */
export const DEFAULT_DSH_DEV_HOME_DISPLAY = `~/${DSH_DEV_HOME_DIR_NAME}`

/**
 * Directory name for the isolated home a community build uses.
 *
 * A community build is a separate product installation too, and it must not
 * reach the home either a release or a development installation owns.
 */
export const DSH_COMMUNITY_HOME_DIR_NAME = '.dsh-community'

/** Stable user-facing display form for the community DeepSeek Harness home. */
export const DEFAULT_DSH_COMMUNITY_HOME_DISPLAY = `~/${DSH_COMMUNITY_HOME_DIR_NAME}`

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default DeepSeek Harness home using Node's platform path rules.
 * @returns the absolute default harness home path.
 */
export function defaultDshHome(): string {
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * Resolve the default home a development build owns, sibling to the release home.
 * @returns the absolute default development harness home path.
 */
export function defaultDshDevHome(): string {
  return join(homedir(), DSH_DEV_HOME_DIR_NAME)
}

/**
 * Resolve the default home a community build owns, sibling to the release and development homes.
 * @returns the absolute default community harness home path.
 */
export function defaultDshCommunityHome(): string {
  return join(homedir(), DSH_COMMUNITY_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the single-root DeepSeek Harness home.
 *
 * Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
 * `~/.dsh`. The harness keeps all user data under one root. An empty or
 * whitespace-only `$DSH_HOME` is treated as unset, so a blank override never
 * resolves the home to the current working directory.
 *
 * `$DSH_HOME` outranks the default, which is what lets an isolated build variant
 * seed it with {@link defaultDshDevHome} or {@link defaultDshCommunityHome} while
 * still honouring an operator who set `$DSH_HOME` deliberately.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())
  return resolve(expandHomePath(selected))
}

/**
 * Join path segments onto the resolved DeepSeek Harness home.
 * @param segments - path segments appended to the Harness home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Join path segments onto the resolved Harness home's `cache` directory without creating it; no arguments returns the directory itself.
 * @param optionsOrSegment - explicit home override, or the first path segment; omission uses the default home resolution.
 * @param segments - additional path segments after the first child, if any.
 * @returns the normalized absolute cache path.
 */
export function dshCachePath(optionsOrSegment: { dshHome?: string } | string = {}, ...segments: string[]): string {
  if (typeof optionsOrSegment === 'string') return dshHomePath('cache', optionsOrSegment, ...segments)
  return join(resolveDshHome(optionsOrSegment.dshHome), 'cache', ...segments)
}

/**
 * Describe a resolved harness home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default home is labelled
 * `~/.dsh`, the development home is labelled `~/.dsh-dev`, the community home
 * is labelled `~/.dsh-community`, and any other configured home is labelled
 * `$DSH_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveDshHome}.
 * @returns `~/.dsh` for the default home, `~/.dsh-dev` for the development home,
 * `~/.dsh-community` for the community home, otherwise `$DSH_HOME`.
 */
export function dshHomeDisplay(resolvedHome: string): string {
  if (resolvedHome === resolve(defaultDshHome())) return DEFAULT_DSH_HOME_DISPLAY
  if (resolvedHome === resolve(defaultDshDevHome())) return DEFAULT_DSH_DEV_HOME_DISPLAY
  if (resolvedHome === resolve(defaultDshCommunityHome())) return DEFAULT_DSH_COMMUNITY_HOME_DISPLAY
  return `$${DSH_HOME_ENV}`
}
