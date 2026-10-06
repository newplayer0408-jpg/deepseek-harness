/**
 * The community release lane publishes three names and three files, and confusing them is the mistake
 * these cases exist to catch. The installer keeps the version it packages, which is upstream's; the
 * release is tagged and titled from the fork's own community version; and the published asset carries
 * the fork's name, because the manifest a running installation reads has to name the file the release
 * serves. A release then uploads exactly three files: that installer, the manifest, and a checksum
 * list.
 *
 * No case can run the workflow here — it needs a Windows runner, a full install, and the network — so
 * they read it as a document. The properties that are about a value (a name, a URL, a permission, a
 * concurrency key) are asserted against the parsed YAML, so a case names the job and the step it means
 * rather than matching a substring somewhere in the file. The properties that are about a command are
 * asserted against the text, because that is where they live. The one property a reading cannot prove
 * is that the packaged application really carries the version file, and that case loads the packaging
 * configuration itself instead of trusting the text.
 *
 * The names the workflow publishes under are not restated here: they are imported from the generator
 * that derives them, so a case fails when the workflow and the release tooling disagree rather than
 * when a copy of a constant drifts.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { COMMUNITY_RELEASE_REPOSITORY, communityInstallerAssetName } from '../scripts/community-release-manifest.ts'
import { parseCommunityRelease, type CommunityReleaseIdentity } from '../src/community-release.ts'
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

/** The same workflow, parsed, so a case can name a job or a step instead of matching text. */
const DOCUMENT: Record<string, unknown> = (() => {
  const parsed: unknown = yaml.load(WORKFLOW)
  if (!isRecord(parsed)) throw new TypeError('the community release workflow must define a workflow')
  return parsed
})()

/** The version facts the release lane and the running application both read. */
const DECLARED = JSON.parse(read(join(DESKTOP, COMMUNITY_VERSION_FILE))) as { communityVersion: string }

/** The release identity the packaged application reads, from the committed file. */
const IDENTITY: CommunityReleaseIdentity = parseCommunityRelease(
  JSON.parse(read(join(DESKTOP, 'community-release.json'))),
)!

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One job of the parsed workflow. */
function job(name: string): Record<string, unknown> {
  if (!isRecord(DOCUMENT.jobs) || !isRecord(DOCUMENT.jobs[name])) {
    throw new TypeError(`the community release workflow must define the ${name} job`)
  }
  return DOCUMENT.jobs[name]
}

/** One job's steps. */
function steps(name: string): Array<Record<string, unknown>> {
  const defined = job(name).steps
  if (!Array.isArray(defined)) throw new TypeError(`the ${name} job must define steps`)
  return defined.filter(isRecord)
}

/** One named step of one job. */
function step(name: string, title: string): Record<string, unknown> {
  const found = steps(name).find(candidate => candidate.name === title)
  if (found === undefined) throw new TypeError(`the ${name} job must define the "${title}" step`)
  return found
}

/** The shell script of one named step. */
function script(name: string, title: string): string {
  const run = step(name, title).run
  if (typeof run !== 'string') throw new TypeError(`the "${title}" step must run a script`)
  return run
}

/** A step's environment. */
function stepEnv(name: string, title: string): Record<string, unknown> {
  const env = step(name, title).env
  if (!isRecord(env)) throw new TypeError(`the "${title}" step must define env`)
  return env
}

/** The workflow-level environment, which names the fork's release destination. */
function workflowEnv(): Record<string, unknown> {
  if (!isRecord(DOCUMENT.env)) throw new TypeError('the community release workflow must define env')
  return DOCUMENT.env
}

/** The version one manifest declares. */
function manifestVersion(path: string): string {
  return (JSON.parse(read(path)) as { version: string }).version
}

describe('the community release lane', () => {
  it('stays manual-only, and keeps publishing opt-in', () => {
    if (!isRecord(DOCUMENT.on)) throw new TypeError('the workflow must define on')
    expect(Object.keys(DOCUMENT.on)).toEqual(['workflow_dispatch'])
    const dispatch = DOCUMENT.on.workflow_dispatch
    if (!isRecord(dispatch) || !isRecord(dispatch.inputs)) throw new TypeError('the workflow must define dispatch inputs')
    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    // The build lane is the default: a dispatch without `publish` never touches a release.
    expect(job('publish').if).toBe('${{ inputs.publish }}')
  })

  it('reads the community version from the committed file rather than from a package manifest', () => {
    expect(WORKFLOW).toContain(`apps/desktop/${COMMUNITY_VERSION_FILE}`)
    // The package manifest stays named exactly once, by the step that pins the installer's own name.
    expect([...WORKFLOW.matchAll(/Get-Content apps\/desktop\/package\.json/gu)]).toHaveLength(1)
  })

  it('validates the file before building, so a malformed version stops the run', () => {
    for (const field of ['communityVersion', 'upstreamBase']) {
      expect(WORKFLOW).toContain(`unusable ${field}`)
    }
  })

  it('derives the upstream commit from the base tag, because the file records no hash', () => {
    // A hash committed beside the tag would be a repository reference that drifts with it, so the
    // workflow resolves the tag in the checkout that holds it — and fetches tags to be able to.
    expect(WORKFLOW).not.toContain('$json.upstreamCommit')
    expect(WORKFLOW).toContain('git rev-list -n 1 $base')
    expect(WORKFLOW).toContain('fetch-tags: true')
    // The lane fails rather than publishing a release that cannot name the commit it packages.
    expect(WORKFLOW).toContain('cannot resolve to a commit')
  })

  it('checks the release tag against the community version before spending the build', () => {
    const tag = step('build', 'Validate the release tag')
    // The tag is operator input, so it never reaches a shell as part of the script text.
    expect(stepEnv('build', 'Validate the release tag')).toMatchObject({
      RELEASE_TAG: '${{ inputs.release_tag }}',
      COMMUNITY_VERSION: '${{ steps.community-version.outputs.version }}',
    })
    const run = script('build', 'Validate the release tag')
    expect(run).toContain('community-v$($env:COMMUNITY_VERSION)')
    expect(run).toContain('$env:RELEASE_TAG -ne $expected')
    expect(String(tag.id)).toBe('release-tag')
    // Both refusals are fail-closed: a malformed tag and a well-formed tag naming another version.
    expect(run).toContain('^community-v\\d{1,4}(\\.\\d{1,5}){0,2}$')
    expect(WORKFLOW).toContain('does not name the version')
    // And it runs before anything is built.
    const order = steps('build').map(candidate => String(candidate.name))
    expect(order.indexOf('Validate the release tag'))
      .toBeLessThan(order.indexOf('Package the community Windows x64 installer'))
    expect(order.indexOf('Validate the release tag')).toBeGreaterThan(order.indexOf('Read the community version'))
  })

  it('publishes under the tag it validated, and never re-derives one', () => {
    const outputs = job('build').outputs
    if (!isRecord(outputs)) throw new TypeError('the build job must define outputs')
    expect(outputs.release_tag).toBe('${{ steps.release-tag.outputs.release_tag }}')
    expect(stepEnv('publish', 'Create or update the GitHub Release')).toMatchObject({
      RELEASE_TAG: '${{ needs.build.outputs.release_tag }}',
    })
    // Creating and rerunning both address the same validated tag.
    expect(WORKFLOW).toContain('gh release create "$RELEASE_TAG"')
    expect(WORKFLOW).toContain('gh release edit "$RELEASE_TAG"')
    expect(WORKFLOW).toContain('gh release upload "$RELEASE_TAG"')
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

  it('publishes exactly the three staged files, and names them where they are uploaded', () => {
    // The build lane stages them and hands on a directory; the publish lane uploads what it received.
    expect(step('build', 'Upload the staged release assets')).toMatchObject({
      uses: 'actions/upload-artifact@v4',
      with: { name: 'community-release-assets', path: 'release-stage/*', 'if-no-files-found': 'error' },
    })
    expect(step('publish', 'Verify the staged release assets')).toBeDefined()
    const download = steps('publish').find(candidate => candidate.uses === 'actions/download-artifact@v4')
    expect(download).toMatchObject({ with: { name: 'community-release-assets', path: 'dist' } })
    // The staged file set is pinned in the build lane, before anything is handed to a job that could
    // publish an extra file nobody named.
    const staged = script('build', 'Verify the staged release assets')
    expect(staged).toContain('$installers.Count -ne 1')
    expect(staged).toContain('SHA256SUMS.txt')
    // And the upload names all three rather than globbing the directory.
    const release = script('publish', 'Create or update the GitHub Release')
    expect(release).toContain('"dist/$asset" "dist/$MANIFEST" dist/SHA256SUMS.txt')
    // A filtered package script runs in the package directory rather than in the workspace, so the
    // staging directory is addressed absolutely: a relative `--out` would stage under `apps/desktop`
    // while the steps that read it back run at the workspace root, and the upload would find nothing.
    expect(script('build', 'Stage the release assets')).toContain("Join-Path $env:GITHUB_WORKSPACE 'release-stage'")
  })

  it('addresses the installer through its release tag, and refuses the moving alias', () => {
    const verify = script('publish', 'Verify the staged release assets')
    // The manifest is the only file a client reads, so its digest and its URL are both checked here.
    expect(verify).toContain('sha256sum -c SHA256SUMS.txt')
    expect(verify).toContain('"sha256": "[0-9a-f]\\{64\\}"')
    expect(verify).toContain('"https://github.com/$REPOSITORY/releases/download/$RELEASE_TAG/$asset"')
    expect(verify).toContain("grep -F 'latest/download'")
    expect(verify).toContain('the manifest does not carry the staged installer\'s digest')
  })

  it('never publishes a prerelease, because the manifest alias skips those', () => {
    // A client discovers the manifest at `releases/latest/download/<manifest>`, and GitHub's `latest`
    // excludes prereleases: marking the release one would hide the file it exists to serve.
    expect(WORKFLOW).not.toContain('--prerelease')
    expect(WORKFLOW).toContain('skips prereleases')
  })

  it('records both version series, and the limitations a user has to know, in the release notes', () => {
    expect(WORKFLOW).toContain('- Community version:')
    expect(WORKFLOW).toContain('v$COMMUNITY_VERSION')
    expect(WORKFLOW).toContain('- Upstream base:')
    expect(WORKFLOW).toContain('$UPSTREAM_BASE')
    expect(WORKFLOW).toContain('$UPSTREAM_COMMIT')
    // The published asset carries the fork's version, so the upstream version it packages is recorded
    // as a fact rather than left to be read out of a file name.
    expect(stepEnv('publish', 'Create or update the GitHub Release').PACKAGED_VERSION)
      .toBe('${{ needs.build.outputs.packaged_version }}')
    expect(WORKFLOW).toContain('(packages $PACKAGED_VERSION)')
    expect(WORKFLOW).toContain('### Known limitations')
    for (const limitation of ['needs one manual install', 'cannot run at the same time', 'no automatic or background installation']) {
      expect(WORKFLOW).toContain(limitation)
    }
  })
})

describe('the release identity the workflow publishes to', () => {
  it('names the manifest the release identity declares, so a client finds it where it looks', () => {
    expect(workflowEnv().COMMUNITY_RELEASE_MANIFEST).toBe(IDENTITY.manifest)
    // The one place the name is spelled in the publish lane is the upload, which has no checkout.
    const release = script('publish', 'Create or update the GitHub Release')
    expect(release).toContain('"dist/$MANIFEST"')
    expect(release).not.toContain('latest-community-v')
  })

  it('publishes to the fork\'s own repository, and to no other', () => {
    expect(workflowEnv().COMMUNITY_RELEASE_REPOSITORY).toBe(IDENTITY.repository)
    expect(COMMUNITY_RELEASE_REPOSITORY).toBe(IDENTITY.repository)
    // Named in the workflow rather than taken from whoever ran it, and compared before anything is
    // created: a copy of the fork cannot publish under this lane's name.
    expect(stepEnv('publish', 'Create or update the GitHub Release')).toMatchObject({
      GH_REPO: '${{ env.COMMUNITY_RELEASE_REPOSITORY }}',
      REPOSITORY: '${{ github.repository }}',
    })
    const release = script('publish', 'Create or update the GitHub Release')
    expect(release).toContain('[ "$REPOSITORY" != "$GH_REPO" ]')
    expect(release).toContain('publishes only to $GH_REPO')
    // A tag that already exists has to name the commit being released, or the release page would
    // attribute these bytes to another one.
    expect(release).toContain('--jq .sha')
    expect(release).toContain('not the built ${{ github.sha }}')
  })

  it('publishes the installer under the name this version publishes, rather than naming it itself', () => {
    // A release version, not the committed one: the committed version is still a development one, and
    // the staging step refuses that before it derives any name at all, so no published name exists yet.
    expect(communityInstallerAssetName('0.2')).toBe('DeepSeek-Harness-Community-v0.2-Windows-x64.exe')
    // No step spells the published name. It is derived by the release tooling from the community
    // version, and a second copy in a command would be a name that could describe a different version
    // than the release derives it from. The header comment names the shape, which is documentation
    // rather than a value any step uses.
    for (const name of ['build', 'publish']) {
      for (const defined of steps(name)) {
        if (typeof defined.run !== 'string') continue
        expect(defined.run, `${String(defined.name)} must not spell the published asset name`)
          .not.toContain('DeepSeek-Harness-Community-v')
      }
    }
    expect(step('build', 'Stage the release assets')).toMatchObject({ shell: 'pwsh' })
    expect(script('build', 'Stage the release assets')).toContain('run community:release:stage')
  })

  it('keeps the checksum list for people, and out of the client', () => {
    // The list is an extra asset for a person verifying a download by hand. A running installation
    // trusts the digest inside the manifest it fetched; nothing it runs reads this file.
    const sources = readdirSync(join(DESKTOP, 'src')).filter(name => name.startsWith('community-') && name.endsWith('.ts'))
    expect(sources.length).toBeGreaterThan(0)
    for (const name of sources) {
      expect(read(join(DESKTOP, 'src', name)), `${name} must not read the checksum list`).not.toContain('SHA256SUMS')
    }
  })
})

describe('the publish lane\'s privileges and serialization', () => {
  it('holds read everywhere and write only where it publishes', () => {
    expect(DOCUMENT.permissions).toEqual({ contents: 'read' })
    expect(job('publish').permissions).toEqual({ contents: 'write' })
    // Nothing else is granted, and no job grants a scope of its own beyond the one write it needs.
    for (const name of Object.keys(DOCUMENT.jobs as Record<string, unknown>)) {
      if (name === 'publish') continue
      expect(job(name).permissions, `${name} must inherit the read-only permissions`).toBeUndefined()
    }
    for (const scope of ['actions', 'packages', 'id-token']) {
      expect(WORKFLOW).not.toContain(`${scope}: write`)
    }
  })

  it('never cancels a release build, and serializes publication per release tag', () => {
    const concurrency = DOCUMENT.concurrency
    expect(concurrency).toEqual({ group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': false })
    // Two runs of the same release must not edit one GitHub Release at once, and a rerun has to be
    // able to finish what the first attempt left half-uploaded. The tag keys the group, so different
    // releases never queue behind one another.
    const publish = job('publish').concurrency
    expect(publish).toMatchObject({
      group: 'release-desktop-community-${{ needs.build.outputs.release_tag }}',
      'cancel-in-progress': false,
    })
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
