// DEV091-INSTALL.I1: the published-state and pinned-quickstart contract.
//
// 0.9.0 was published on 2026-11-26 (GitHub release + npm). The old contract in
// this file pinned 0.8.6 as the current stable and described 0.9.0 as an
// unpublished candidate; that state is now historical. The oracle below is
// deterministic: it reads the repository files and compares them with a fixed
// release fixture captured from the official readbacks. It never performs a
// network request, so a mutable npm dist-tag or GitHub response cannot change
// the result of a test run.
//
// The negative fixtures prove the oracle is not merely permissive: the old
// 0.8.6-current / 0.9.0-unpublished wording and an unpinned Host install must
// both fail the same checks the real documents pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

// Fixed release evidence. Source: #81 REL090-STABLE.RELEASE_R1
// (comment 7179544779) and the publication-state comments on #94/#81.
const RELEASE = Object.freeze({
  version: '0.9.0',
  date: '2026-11-26',
  previousStable: '0.8.6',
  historicalPrerelease: '0.9.0-rc.1',
  futureVersion: '0.9.1',
  githubReleaseId: '458821277',
  tag: 'v0.9.0',
  tagObject: 'f9fbbb8fa0470b086c76e1058f2149f2fa8e4faf',
  commit: '8f85ab4a0563c9366c8469d4ffaf7697563cfc36',
  githubPublishedAt: '2026-11-26T01:01:54Z',
  npmPublishedAt: '2026-11-26T01:05:32.535Z',
  t0: '2026-11-26T01:11:07Z',
  assetName: 'dsh-ssh-tui-0.9.0.tgz',
  assetBytes: 1638517,
  assetSha256: 'a0f53a972bdab7e1d714a9dd9edf3d516cff53c183a27155c45730c9f98c3ae1',
  npmShasum: '4ca0edd5ccecfbbbdf8fbcbe4f7cce1836b705a6',
  npmIntegrity:
    'sha512-cw6GfTMhK8Yy/Gw7E1/CsA0qbqJSfFqVKE0lFoMWySCbS1chGQbOolEYzGIePWj2To9YcPIc30Zj+x4qaMfeqQ==',
  latestAtReadback: '0.9.0',
  nextAtReadback: '0.9.0',
  exactHostExample: '0.2.2-rc.5',
  fallbackHostExample: '0.2.2-rc.3',
  nodeFloor: '24.9.0',
});

const HOSTS = Object.freeze([
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-rc.2',
  '0.2.1-rc.5',
  '0.2.2-rc.1',
  '0.2.2-rc.2',
  '0.2.2-rc.3',
  '0.2.2-rc.4',
  '0.2.2-rc.5',
]);
const UNION = HOSTS.join(' || ');

function firstFence(text) {
  const match = text.match(/```(?:bash|sh|powershell)\n([\s\S]*?)```/);
  assert.ok(match, 'expected a quickstart fenced code block');
  return match[1];
}

function assertPublishedStateZh(text) {
  assert.match(
    text,
    /当前已发布的稳定版是 `0\.9\.0`（2026-11-26）/,
    'README.md must name 0.9.0 (2026-11-26) as the current published stable',
  );
  assert.match(
    text,
    /0\.8\.6[^\n]{0,80}(?:均为历史|历史版本|historical)/,
    'README.md must mark 0.8.6 as historical, not current',
  );
  assert.match(
    text,
    /0\.9\.0-rc\.1[^\n]{0,100}(?:均为历史|历史|historical)/,
    'README.md must mark 0.9.0-rc.1 as historical',
  );
  assert.match(
    text,
    /`0\.9\.1`[^\n]{0,100}(?:尚未发布|未发布)/,
    'README.md must mark 0.9.1 as unreleased',
  );
  assert.match(
    text,
    /package identity[^\n]{0,40}`0\.9\.0`/,
    'README.md must say the package identity stays 0.9.0 during 0.9.1 development',
  );
  assert.match(
    text,
    /npm `latest` \/ `next` 均为 `0\.9\.0`/,
    'README.md must record the publication readback of both dist-tags',
  );
  assert.match(
    text,
    /2026-11-26 的读回/,
    'README.md must scope the dist-tag state to the 2026-11-26 readback',
  );
  assert.match(
    text,
    /HOLD/,
    'README.md must retain the independent registry/asset readback HOLD',
  );
  assert.match(text, /EVIDENCE_LIMITED/, 'README.md must retain the evidence limitation label');
  assert.match(
    text,
    /NOT_MEASURED|NOT MEASURED/,
    'README.md must retain the not-measured boundary',
  );

  // Negative contract: these old statements must be gone.
  assert.doesNotMatch(
    text,
    /当前已发布的稳定版是 `0\.8\.6`/,
    'README.md still calls 0.8.6 the current published stable',
  );
  assert.doesNotMatch(
    text,
    /尚未公开发布的 `0\.9\.0` 稳定候选/,
    'README.md still calls 0.9.0 an unpublished stable candidate',
  );
  assert.doesNotMatch(
    text,
    /stable candidate in preparation/,
    'README.md still carries the pre-publication candidate status',
  );
}

function assertPublishedStateEn(text) {
  assert.match(
    text,
    /current published stable release is `0\.9\.0` \(2026-11-26[,)]/i,
    'README.en.md must name 0.9.0 (2026-11-26) as the current published stable',
  );
  assert.match(
    text,
    /0\.8\.6[^\n]{0,80}(?:historical|previous stable)/i,
    'README.en.md must mark 0.8.6 as historical, not current',
  );
  assert.match(
    text,
    /0\.9\.0-rc\.1[^\n]{0,100}(?:historical|history)/i,
    'README.en.md must mark 0.9.0-rc.1 as historical',
  );
  assert.match(
    text,
    /`0\.9\.1`[^\n]{0,120}(?:unreleased|not yet published|future)/i,
    'README.en.md must mark 0.9.1 as unreleased',
  );
  assert.match(
    text,
    /package identity[^\n]{0,50}`0\.9\.0`/i,
    'README.en.md must say the package identity stays 0.9.0 during 0.9.1 development',
  );
  assert.match(
    text,
    /npm `latest` \/ `next`[^\n]{0,40}`0\.9\.0`/i,
    'README.en.md must record the publication readback of both dist-tags',
  );
  assert.match(
    text,
    /2026-11-26 readback/i,
    'README.en.md must scope the dist-tag state to the 2026-11-26 readback',
  );
  assert.match(
    text,
    /HOLD/,
    'README.en.md must retain the independent registry/asset readback HOLD',
  );
  assert.match(text, /EVIDENCE_LIMITED/, 'README.en.md must retain the evidence limitation label');
  assert.match(
    text,
    /NOT_MEASURED|NOT MEASURED/,
    'README.en.md must retain the not-measured boundary',
  );

  assert.doesNotMatch(
    text,
    /current published stable release is `0\.8\.6`/i,
    'README.en.md still calls 0.8.6 the current published stable',
  );
  assert.doesNotMatch(
    text,
    /unreleased[^\n]{0,40}`0\.9\.0` stable candidate/i,
    'README.en.md still calls 0.9.0 an unpublished stable candidate',
  );
  assert.doesNotMatch(
    text,
    /stable candidate in preparation/i,
    'README.en.md still carries the pre-publication candidate status',
  );
}

function assertPinnedQuickstart(name, text) {
  const fence = firstFence(text);

  assert.match(
    fence,
    /node --version/,
    `${name} quickstart must check Node before installing`,
  );
  assert.match(
    fence,
    />= ?24\.9\.0/,
    `${name} quickstart must state the Node >=24.9.0 floor`,
  );
  assert.ok(
    fence.includes(`npm i -g @deepseek-ai/dsh@${RELEASE.exactHostExample}`),
    `${name} quickstart must install the exact admitted Host ${RELEASE.exactHostExample}`,
  );
  assert.match(
    fence,
    /dsh --version/,
    `${name} quickstart must check the installed Host version before adding the Relay`,
  );
  assert.ok(
    fence.includes(`dsh plugin --profile tui add dsh-ssh-tui@${RELEASE.version}`),
    `${name} quickstart must install the exact published Relay ${RELEASE.version}`,
  );
  assert.match(
    fence,
    /dsh --profile tui/,
    `${name} quickstart must launch with an explicit profile`,
  );
  assert.match(
    text,
    /NOT_ADMITTED/,
    `${name} must explicitly mark newer, unadmitted Hosts as NOT_ADMITTED`,
  );

  // A host install without an exact version is the defect this test pins.
  assert.doesNotMatch(
    text,
    /npm (?:i|install) -g @deepseek-ai\/dsh(?:\s|$)/m,
    `${name} still contains an unpinned Host install`,
  );
  assert.doesNotMatch(
    text,
    /@deepseek-ai\/dsh@latest/,
    `${name} must not suggest the unadmitted latest Host`,
  );
  assert.doesNotMatch(
    text,
    /dsh plugin add --profile/,
    `${name} must keep --profile before the plugin subcommand`,
  );

  for (const line of text.split('\n')) {
    if (/^\s*(?:npm i|dsh plugin)/.test(line)) {
      assert.doesNotMatch(
        line,
        /--force|--legacy-peer-deps/,
        `${name} must not suggest bypassing peer resolution: ${line.trim()}`,
      );
    }
  }
}

test('READMEs publish 0.9.0 as current stable and keep 0.8.6 / rc.1 historical', () => {
  const zh = read('README.md');
  const en = read('README.en.md');

  assertPublishedStateZh(zh);
  assertPublishedStateEn(en);

  // The fixture itself is the release identity, not whatever the package under
  // test happens to contain: a local version bump cannot make the docs "right".
  assert.equal(RELEASE.version, '0.9.0');
  assert.equal(RELEASE.previousStable, '0.8.6');
  assert.equal(RELEASE.historicalPrerelease, '0.9.0-rc.1');
});

test('READMEs distinguish the immutable 0.9.0 release from unreleased 0.9.1 development', () => {
  for (const name of ['README.md', 'README.en.md']) {
    const text = read(name);
    assert.ok(text.includes(RELEASE.futureVersion), `${name} must name the future 0.9.1 line`);
    assert.ok(
      text.includes(`\`${RELEASE.version}\``),
      `${name} must keep the immutable 0.9.0 identity`,
    );
    assert.doesNotMatch(
      text,
      /v0\.9\.1|releases\/tag\/v0\.9\.1|dsh-ssh-tui@0\.9\.1/,
      `${name} must not hardcode an unapproved 0.9.1 release`,
    );
  }
});

test('READMEs keep the exact nine-Host union, matrix counts and qualified limits', () => {
  for (const name of ['README.md', 'README.en.md']) {
    const text = read(name);
    assert.ok(text.includes(UNION), `${name} must keep the exact nine-Host union`);
    for (const host of HOSTS) {
      assert.ok(text.includes(host), `${name} must list the exact Host pin ${host}`);
    }
    assert.match(text, /九条 Host|nine (?:exact )?Hosts?/i, `${name} must state the nine-Linux matrix`);
    assert.match(
      text,
      /六条 ConPTY|six-line ConPTY|six ConPTY/i,
      `${name} must state the six-line ConPTY subset`,
    );
    assert.match(
      text,
      /characterization|表征/i,
      `${name} must keep the synthetic characterization leg`,
    );
    assert.match(
      text,
      /Windows Server[^\n]{0,80}(?:2025|Server)/i,
      `${name} must keep the Windows Server exclusion`,
    );
    assert.match(text, /Windows 11/, `${name} must keep the Windows 11 boundary`);
    assert.match(text, /IME/, `${name} must keep the IME boundary`);
  }
});

test('READMEs and docs/windows.md pin the exact admitted Host in the quickstart', () => {
  assertPinnedQuickstart('README.md', read('README.md'));
  assertPinnedQuickstart('README.en.md', read('README.en.md'));
  assertPinnedQuickstart('docs/windows.md', read('docs/windows.md'));
});

test('the published-state oracle rejects the old 0.8.6-current / 0.9.0-unpublished fixture', () => {
  const oldZh = [
    '当前已发布的稳定版是 `0.8.6`，覆盖七个冻结 Host 版本。',
    '本分支是尚未公开发布的 `0.9.0` 稳定候选（package identity `0.9.0`，stable candidate in preparation）。',
  ].join('\n');
  const oldEn = [
    'The current published stable release is `0.8.6`, covering seven frozen Host versions.',
    'This branch is the unreleased `0.9.0` stable candidate (package identity `0.9.0`, stable candidate in preparation).',
  ].join('\n');

  assert.throws(
    () => assertPublishedStateZh(oldZh),
    /must name 0\.9\.0 \(2026-11-26\) as the current published stable/,
  );
  assert.throws(
    () => assertPublishedStateEn(oldEn),
    /must name 0\.9\.0 \(2026-11-26\) as the current published stable/,
  );
});

test('the quickstart oracle rejects an unpinned Host and forced peer bypass', () => {
  const unpinned = [
    '```bash',
    'node --version                    # >= 24.9.0',
    'npm i -g @deepseek-ai/dsh',
    'dsh --version',
    'dsh plugin --profile tui add dsh-ssh-tui@0.9.0',
    'dsh --profile tui',
    '```',
    'Any newer Host is NOT_ADMITTED.',
  ].join('\n');
  const forced = [
    '```bash',
    'node --version                    # >= 24.9.0',
    'npm i -g @deepseek-ai/dsh@0.2.2-rc.5',
    'dsh --version',
    'dsh plugin --profile tui add dsh-ssh-tui@0.9.0 --force',
    'dsh --profile tui',
    '```',
    'Any newer Host is NOT_ADMITTED.',
  ].join('\n');

  assert.throws(
    () => assertPinnedQuickstart('unpinned-fixture', unpinned),
    /exact admitted Host 0\.2\.2-rc\.5/,
  );
  assert.throws(
    () => assertPinnedQuickstart('forced-fixture', forced),
    /must not suggest bypassing peer resolution/,
  );
});
