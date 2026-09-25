import type { BeforePackContext } from 'app-builder-lib'

/**
 * Longest `--program-directory` the pinned LibreOfficeKit native helper accepts on Windows.
 *
 * Characterised against the engine build pinned in dsh-v0.1.7-rc.1, not an upstream API guarantee.
 */
export const WINDOWS_OFFICE_PROGRAM_DIRECTORY_BUDGET: 199

/**
 * Install source-relative PE patterns in the active builder configuration.
 * @param context Active builder configuration and cleanup owner.
 * @param sourceRoot Verified prepared dsh directory; external sources receive a build-owned staging copy.
 * @returns PE paths relative to the original prepared directory.
 */
export function prepareWindowsAsarUnpack(context: BeforePackContext, sourceRoot: string): Promise<string[]>

/**
 * Resolve the engine directory the assembled application passes as `--program-directory`.
 * @param resourcesDir Assembled application resources directory.
 * @param platform Engine platform of the packaged payload.
 * @param arch Engine architecture of the packaged payload.
 * @returns Absolute engine program directory inside the assembled application.
 */
export function windowsOfficeProgramDirectory(resourcesDir: string, platform: string, arch: string): string

/**
 * Reject an assembled Windows application whose Office engine path exceeds the measured budget.
 * @param resourcesDir Assembled application resources directory.
 * @param platform Engine platform of the packaged payload.
 * @param arch Engine architecture of the packaged payload.
 * @returns Verified engine program directory.
 */
export function verifyWindowsOfficeEnginePathBudget(resourcesDir: string, platform: string, arch: string): string

/**
 * Reject inline, absent, linked, or changed PE files in the assembled application.
 * @param sourceRoot Original signed and sealed dsh directory.
 * @param resourcesDir Assembled application resources directory.
 * @param files PE paths returned by prepareWindowsAsarUnpack.
 * @returns Resolves after every PE has an unpacked ASAR entry and identical bytes.
 */
export function verifyWindowsAsarUnpack(sourceRoot: string, resourcesDir: string, files: string[]): Promise<void>
