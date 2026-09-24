/** Keep prepared Windows PE files outside ASAR without changing their sealed bytes. */
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readAsar } from 'app-builder-lib/out/asar/asar.js'
import { windowsRuntimeCode } from './windows-runtime-signature.mjs'

function inside(root, file) {
  const suffix = relative(root, file)
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

function unpackPattern(path) {
  // Builder removes backslash escapes; brace expansion also ignores character classes.
  // A brace matches one character, so similarly named neighbors may also be unpacked.
  return path.split(sep).join('/').replace(/[\[\]{}()*?+@#]/gu,
    character => character === '{' || character === '}' ? '?' : `[${character}]`).replace(/^!/u, '@(!)')
}

/**
 * Install source-relative PE patterns in the configuration consumed by electron-builder.
 * @param {import('app-builder-lib').BeforePackContext} context Active builder configuration and cleanup owner.
 * @param {string} sourceRoot Verified prepared dsh directory; its files remain unchanged.
 * @returns {Promise<string[]>} PE paths relative to the original prepared directory.
 */
export async function prepareWindowsAsarUnpack(context, sourceRoot) {
  const files = (await windowsRuntimeCode(sourceRoot)).map(file => relative(sourceRoot, file))
  const { config, info } = context.packager
  const { appDir } = info
  let copyRoot = sourceRoot
  if (!inside(appDir, sourceRoot)) {
    // Builder's source matcher slices the appDir prefix even for external FileSets.
    const parent = join(appDir, '.desktop-build')
    await mkdir(parent, { recursive: true })
    const stage = await mkdtemp(join(parent, 'asar-source-'))
    copyRoot = join(stage, 'dsh')
    info.disposeOnBuildFinish(() => rm(stage, { recursive: true, force: true }))
    await cp(sourceRoot, copyRoot, { recursive: true, force: false, errorOnExist: true })
    config.files = config.files.map(file => {
      if (typeof file === 'string' || file.from === undefined) return file
      const from = resolve(appDir, file.from)
      return inside(sourceRoot, from) ? { ...file, from: join(copyRoot, relative(sourceRoot, from)) } : file
    })
  }
  const existing = config.asarUnpack ?? []
  config.asarUnpack = [...(typeof existing === 'string' ? [existing] : existing),
    ...files.map(file => unpackPattern(relative(appDir, join(copyRoot, file))))]
  return files
}

/**
 * Longest `--program-directory` the pinned LibreOfficeKit native helper accepts on Windows.
 *
 * Measured against one byte-identical `libreoffice-kit-win32-x64` copy reached through junctions of
 * increasing length: 199 characters convert a DOCX and 200 fail. Above the budget the helper keeps
 * running but cannot stat its own registry, and the failure surfaces as
 * `Unknown LibreOfficeKit exception` at conversion time instead of a missing-file error.
 *
 * This is a characterised limit of the engine build pinned in dsh-v0.1.7-rc.1
 * (`@deepseek-ai/libreoffice-kit@0.1.0` with `@deepseek-ai/libreoffice-kit-win32-x64@0.1.0`), not an
 * upstream API guarantee: re-measure it whenever those packages are upgraded.
 */
export const WINDOWS_OFFICE_PROGRAM_DIRECTORY_BUDGET = 199

/**
 * Resolve the engine directory the assembled application passes as `--program-directory`.
 * @param {string} resourcesDir Assembled application resources directory.
 * @param {string} platform Engine platform of the packaged payload.
 * @param {string} arch Engine architecture of the packaged payload.
 * @returns {string} Absolute engine program directory inside the assembled application.
 */
export function windowsOfficeProgramDirectory(resourcesDir, platform, arch) {
  return join(resourcesDir, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai',
    `libreoffice-kit-${platform}-${arch}`, 'program', 'program')
}

/**
 * Reject an assembled Windows application whose Office engine path exceeds the measured budget.
 *
 * Checking while packaging keeps an overlong checkout a build error instead of the runtime
 * `Unknown LibreOfficeKit exception` it would otherwise cause.
 * @param {string} resourcesDir Assembled application resources directory.
 * @param {string} platform Engine platform of the packaged payload.
 * @param {string} arch Engine architecture of the packaged payload.
 * @returns {string} Verified engine program directory.
 */
export function verifyWindowsOfficeEnginePathBudget(resourcesDir, platform, arch) {
  const programDirectory = windowsOfficeProgramDirectory(resourcesDir, platform, arch)
  if (programDirectory.length > WINDOWS_OFFICE_PROGRAM_DIRECTORY_BUDGET) {
    throw new Error(`Windows Office engine: --program-directory is ${programDirectory.length} characters,`
      + ` beyond the ${WINDOWS_OFFICE_PROGRAM_DIRECTORY_BUDGET}-character budget of the pinned`
      + ` LibreOfficeKit engine: ${programDirectory}`)
  }
  return programDirectory
}

/**
 * Reject inline, absent, linked, or changed PE files in the assembled application.
 * @param {string} sourceRoot Original signed and sealed dsh directory.
 * @param {string} resourcesDir Assembled application resources directory.
 * @param {string[]} files PE paths returned by prepareWindowsAsarUnpack.
 * @returns {Promise<void>} Resolves after every PE has an unpacked ASAR entry and identical bytes.
 */
export async function verifyWindowsAsarUnpack(sourceRoot, resourcesDir, files) {
  const archive = await readAsar(join(resourcesDir, 'app.asar'))
  for (const file of files) {
    const entry = archive.getFile(join('dsh', file), false)
    if (entry.unpacked !== true || entry.link !== undefined) {
      throw new Error(`Windows ASAR: PE must be unpacked: ${file}`)
    }
    const copied = join(resourcesDir, 'app.asar.unpacked', 'dsh', file)
    const stat = await lstat(copied)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Windows ASAR: expected a real PE file: ${file}`)
    const [prepared, packaged] = await Promise.all([readFile(join(sourceRoot, file)), readFile(copied)])
    if (!prepared.equals(packaged)) throw new Error(`Windows ASAR: PE bytes changed: ${file}`)
  }
}
