/**
 * The community release lane publishes two versions, and confusing them is the mistake these cases
 * exist to catch: the installer keeps the version it packages, which is upstream's, while the release
 * tag and the release title carry the fork's own community version.
 *
 * No case can run the workflow here — it needs a Windows runner, a full install, and the network — so
 * they read the workflow, the packaging configuration, and the manifests as text and pin the
 * properties that would otherwise break silently on the next release. The one property a text read
 * cannot prove is that the packaged application really carries the version file, and that case loads
 * the packaging configuration itself instead of trusting the text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMMUNITY_VERSION_FILE } from '../src/community-version.ts'

/** The application directory, and the repository root it belongs to. */
const DESKTOP = fileURLToPath(new URL('../', import.meta.url))
const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url))

/** Read one file as text. */
function read(path: string): string {
  return readFileSync(path, 'utf8')
}

/** The workflow that builds, and optionally publishes, the community installer. */
const WORKFLOW = read(join(REPOSITORY, '.github/workflows/release-desktop-community.yml'))

/** The version facts the release lane and the running application both read. */
const DECLARED = JSON.parse(read(join(DESKTOP, COMMUNITY_VERSION_FILE))) as { communityVersion: string }

/** The version one manifest declares. */
function manifestVersion(path: string): string {
  return (JSON.parse(read(path)) as { version: string }).version
}

describe('the community release lane', () => {
  it('reads the community version from the committed file rather than from a package manifest', () => {
    expect(WORKFLOW).toContain(`apps/desktop/${COMMUNITY_VERSION_FILE}`)
    // The package manifest stays named exactly once, by the step that pins the installer's own name.
    expect([...WORKFLOW.matchAll(/Get-Content apps\/desktop\/package\.json/gu)]).toHaveLength(1)
  })

  it('validates the file before building, so a malformed version stops the run', () => {
    for (const field of ['communityVersion', 'upstreamBase', 'upstreamCommit']) {
      expect(WORKFLOW).toContain(`unusable ${field}`)
    }
  })

  it('names the release tag and the release title from the community version', () => {
    expect(WORKFLOW).toContain('gh release create "community-v$COMMUNITY_VERSION"')
    expect(WORKFLOW).toContain('DeepSeek Harness Community v$COMMUNITY_VERSION')
    // The tag never falls back to the packaged version, which is upstream's series and not the fork's.
    expect(WORKFLOW).not.toContain('community-v$version')
  })

  it('hands the version to the publish lane, which holds no checkout of its own', () => {
    expect(WORKFLOW).toContain('community_version: ${{ steps.community-version.outputs.version }}')
    expect(WORKFLOW).toContain('COMMUNITY_VERSION: ${{ needs.build.outputs.community_version }}')
  })

  it('still verifies the installer by the version it packages', () => {
    expect(WORKFLOW).toContain('$expected = "deepseek-harness-$version-win-x64-community-unsigned.exe"')
    expect(WORKFLOW).toContain('(Get-Content apps/desktop/package.json -Raw | ConvertFrom-Json).version')
  })

  it('records both version series in the release notes', () => {
    expect(WORKFLOW).toContain('- Community version:')
    expect(WORKFLOW).toContain('v$COMMUNITY_VERSION')
    expect(WORKFLOW).toContain('- Upstream base:')
    expect(WORKFLOW).toContain('$UPSTREAM_BASE')
    expect(WORKFLOW).toContain('$UPSTREAM_COMMIT')
  })
})

describe('the packaged community application', () => {
  it('ships the version file the shell reads at runtime', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const builder = createElectronBuilderConfig({
      DSH_DESKTOP_VARIANT: 'community',
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(builder.files).toContain(COMMUNITY_VERSION_FILE)
    // It travels the same way the manifest does, so the two are always read from one directory.
    expect(builder.files).toContain('package.json')
  }, 60_000)

  it('keeps the fork\'s own version out of the upstream package manifests', () => {
    // The fork packages upstream's version rather than replacing it, so neither manifest may move to
    // the community series. This is what keeps the installer name honest about what it packages.
    for (const path of [join(DESKTOP, 'package.json'), join(REPOSITORY, 'package.json')]) {
      const version = manifestVersion(path)
      expect(version).not.toBe(DECLARED.communityVersion)
      expect(version).not.toContain(DECLARED.communityVersion)
    }
  })
})
