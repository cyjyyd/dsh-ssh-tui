// DEV091-INSTALL.I1: release identity is a state machine, and the state moved.
//
// 0.9.0 was published on 2026-11-26 (GitHub release + npm). This test pins the
// new state without losing the historical facts it used to protect:
//   - package/lock identity 0.9.0 and the exact nine-Host union;
//   - the immutable published 0.9.0 release, its exact GitHub/npm readback
//     evidence, and the still-open independent byte readback HOLD;
//   - 0.8.6 and 0.9.0-rc.1 as historical, never current;
//   - 0.9.1 as a future, unreleased development line; no 0.9.1 tag/release;
//   - the Chinese + English Windows Server exclusion and its original RED/D5
//     links;
//   - the 0.9.0 release notes, the preserved rc.1 historical notes, the
//     CHANGELOG and the candidate evidence inventory.
//
// The oracle is deterministic: it reads repository files and compares them to
// fixed release evidence. It never fetches npm or GitHub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

const HOSTS = [
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-rc.2',
  '0.2.1-rc.5',
  '0.2.2-rc.1',
  '0.2.2-rc.2',
  '0.2.2-rc.3',
  '0.2.2-rc.4',
  '0.2.2-rc.5',
];
const UNION = HOSTS.join(' || ');
const RELEASE = '0.9.0';
const PREVIOUS_STABLE = '0.8.6';
const RC1 = '0.9.0-rc.1';
const FUTURE = '0.9.1';
const RED_RUN =
  'https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/44881356855/job/136777141174';
const D5_AUDIT =
  'https://github.com/cyjyyd/dsh-ssh-tui/pull/89#issuecomment-7090676703';
const MAIN_CI_ATTEMPT1 =
  'https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/45735121259/attempts/1';
const MAIN_CI_ATTEMPT2 =
  'https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/45735121259/attempts/2';

// Exact publication evidence from #81 REL090-STABLE.RELEASE_R1
// (comment 7179544779). These values are data, not live lookups.
const EVIDENCE = {
  version: '0.9.0',
  date: '2026-11-26',
  githubReleaseId: '458821277',
  tagObject: 'f9fbbb8fa0470b086c76e1058f2149f2fa8e4faf',
  commit: '8f85ab4a0563c9366c8469d4ffaf7697563cfc36',
  githubPublishedAt: '2026-11-26T01:01:54Z',
  npmPublishedAt: '2026-11-26T01:05:32.535Z',
  t0: '2026-11-26T01:11:07Z',
  assetName: 'dsh-ssh-tui-0.9.0.tgz',
  assetBytes: '1,638,517',
  assetSha256: 'a0f53a972bdab7e1d714a9dd9edf3d516cff53c183a27155c45730c9f98c3ae1',
  npmShasum: '4ca0edd5ccecfbbbdf8fbcbe4f7cce1836b705a6',
  npmIntegrity:
    'sha512-cw6GfTMhK8Yy/Gw7E1/CsA0qbqJSfFqVKE0lFoMWySCbS1chGQbOolEYzGIePWj2To9YcPIc30Zj+x4qaMfeqQ==',
};
const ZH_DISCLOSURE =
  'Windows Server 系列（含 Server 2025）不在 0.9.0 支持范围。历史 Windows Server 2025 question-wait 双换行 CI RED 仍保留，根因未明；不保证 Server 兼容性。';
const EN_DISCLOSURE =
  'Windows Server family (including Server 2025) is outside the supported scope of 0.9.0. The historical Windows Server 2025 question-wait double-newline CI RED remains, with root cause unknown; Server compatibility is not guaranteed.';
const ZH_RC1_DISCLOSURE =
  'Windows Server 系列（含 Server 2025）不在 0.9.0-rc.1 支持范围。历史 Windows Server 2025 question-wait 双换行 CI RED 仍保留，根因未明；不保证 Server 兼容性。';
const EN_RC1_DISCLOSURE =
  'Windows Server family (including Server 2025) is outside the supported scope of 0.9.0-rc.1. The historical Windows Server 2025 question-wait double-newline CI RED remains, with root cause unknown; Server compatibility is not guaranteed.';

test('package identity is the published 0.9.0 stable with nine Hosts; 0.9.1 stays future', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));

  assert.equal(pkg.version, RELEASE, 'package.json must identify the published 0.9.0 stable');
  assert.equal(lock.version, RELEASE, 'package-lock.json root version must match the package');
  assert.equal(
    lock.packages['']?.version,
    RELEASE,
    'package-lock.json packages[""].version must match the package',
  );
  assert.notEqual(pkg.version, FUTURE, 'the future 0.9.1 line must not be hardcoded in package.json');

  const compat = pkg.dsh?.compatibility;
  assert.ok(compat, 'package.json must keep dsh.compatibility');
  assert.equal(
    compat.dsh,
    UNION,
    'dsh.compatibility.dsh must stay the exact nine-Host union, with no Host dropped',
  );
  assert.equal(
    pkg.peerDependencies['@deepseek-ai/dsh-agent'],
    UNION,
    'the root peer window must agree with dsh.compatibility.dsh',
  );

  for (const host of HOSTS) {
    assert.equal(
      compat.dshReleases[host],
      'compatible',
      `dshReleases must keep ${host} compatible`,
    );
    assert.ok(
      UNION.split(' || ').includes(host),
      `${host} must be in the declared nine-Host union`,
    );
  }
  assert.equal(
    Object.values(compat.dshReleases).filter((state) => state === 'compatible').length,
    9,
    'exactly nine Host releases are compatible for the published 0.9.0 stable',
  );
});

test('READMEs distinguish published 0.9.0 from historical 0.8.6 / rc.1 and unreleased 0.9.1', () => {
  const zh = read('README.md');
  const en = read('README.en.md');

  for (const [name, text] of [['README.md', zh], ['README.en.md', en]]) {
    assert.ok(
      !text.includes('COMPAT_ADMISSION_PENDING'),
      `${name} still describes rc.4/rc.5 admission as pending`,
    );
    assert.match(
      text,
      /package identity[^\n]{0,50}`0\.9\.0`/i,
      `${name} must keep the 0.9.0 package identity during 0.9.1 development`,
    );
    assert.ok(text.includes(RC1), `${name} must record the historical ${RC1} prerelease`);
    assert.match(text, /EVIDENCE_LIMITED/, `${name} must keep the evidence limitation label`);
    assert.match(
      text,
      /NOT_MEASURED|NOT MEASURED/,
      `${name} must keep the not-measured boundary explicit`,
    );
    assert.match(text, /NOT_ADMITTED/, `${name} must distinguish newer unadmitted Hosts`);
  }

  // Current published stable is 0.9.0, dated 2026-11-26.
  assert.match(
    zh,
    /当前已发布的稳定版是 `0\.9\.0`（2026-11-26）/,
    'README.md must name 0.9.0 (2026-11-26) as published stable',
  );
  assert.match(
    en,
    /current published stable release is `0\.9\.0` \(2026-11-26[,)]/i,
    'README.en.md must name 0.9.0 (2026-11-26) as published stable',
  );

  // 0.8.6 and rc.1 are historical, not current.
  assert.match(zh, /0\.8\.6[^\n]{0,80}均为历史/, 'README.md must mark 0.8.6 historical');
  assert.match(en, /0\.8\.6[^\n]{0,80}historical/i, 'README.en.md must mark 0.8.6 historical');
  assert.match(zh, /0\.9\.0-rc\.1[^\n]{0,100}均为历史/, 'README.md must mark rc.1 historical');
  assert.match(en, /0\.9\.0-rc\.1[^\n]{0,100}historical/i, 'README.en.md must mark rc.1 historical');

  // 0.9.1 is future/unreleased, never a release claim.
  assert.match(zh, /`0\.9\.1`[^\n]{0,100}(?:尚未发布|未发布)/, 'README.md must mark 0.9.1 unreleased');
  assert.match(
    en,
    /`0\.9\.1`[^\n]{0,120}(?:unreleased|not yet published|future)/i,
    'README.en.md must mark 0.9.1 unreleased',
  );
  assert.doesNotMatch(zh, /v0\.9\.1|releases\/tag\/v0\.9\.1/, 'README.md must not invent a v0.9.1 release');
  assert.doesNotMatch(en, /v0\.9\.1|releases\/tag\/v0\.9\.1/, 'README.en.md must not invent a v0.9.1 release');

  // Old candidate wording is gone.
  assert.doesNotMatch(zh, /尚未公开发布的 `0\.9\.0` 稳定候选/, 'README.md still calls 0.9.0 unpublished');
  assert.doesNotMatch(en, /unreleased[^\n]{0,40}`0\.9\.0` stable candidate/i, 'README.en.md still calls 0.9.0 unpublished');
  assert.doesNotMatch(zh, /stable candidate in preparation/, 'README.md still carries candidate status');
  assert.doesNotMatch(en, /stable candidate in preparation/i, 'README.en.md still carries candidate status');
});

test('READMEs carry the conspicuous Chinese + English Windows Server exclusion', () => {
  for (const name of ['README.md', 'README.en.md']) {
    const text = read(name);
    assert.ok(text.includes(ZH_DISCLOSURE), `${name} is missing the exact Chinese OS disclosure`);
    assert.ok(text.includes(EN_DISCLOSURE), `${name} is missing the exact English OS disclosure`);
    assert.ok(text.includes(RED_RUN), `${name} must link the original Windows Server 2025 RED`);
    assert.ok(text.includes(D5_AUDIT), `${name} must link the bounded D5 audit`);
  }
});

test('rc.1 release notes are preserved as the published historical prerelease', () => {
  const path = 'docs/release-notes-0.9.0-rc.1.md';
  assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} must exist`);
  const notes = read(path);

  assert.match(notes, /HISTORICAL PUBLISHED PRERELEASE/, `${path} must be marked historical`);
  assert.match(notes, /GitHub prerelease/, `${path} must record the published GitHub prerelease`);
  assert.match(notes, /npm dist-tag `next`/, `${path} must record the published npm next tag`);
  assert.ok(
    notes.includes(ZH_RC1_DISCLOSURE),
    `${path} must keep the historical Chinese 0.9.0-rc.1 disclosure verbatim`,
  );
  assert.ok(
    notes.includes(EN_RC1_DISCLOSURE),
    `${path} must keep the historical English 0.9.0-rc.1 disclosure verbatim`,
  );
  assert.ok(
    notes.includes('docs/release-notes-0.9.0.md'),
    `${path} must link the now-published 0.9.0 release notes`,
  );
  assert.match(
    notes,
    /`?0\.9\.0`? 已于 2026-11-26 发布为 Stable/,
    `${path} must point to the published 0.9.0 stable without rewriting its own history`,
  );
  assert.ok(notes.includes(RED_RUN), `${path} must preserve the historical RED link verbatim`);
  assert.ok(notes.includes(D5_AUDIT), `${path} must preserve the historical D5 link verbatim`);
});

test('release notes record the immutable published 0.9.0 release and exact evidence', () => {
  const path = 'docs/release-notes-0.9.0.md';
  assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} must exist`);
  const notes = read(path);

  assert.match(notes, /# 0\.9\.0 — 已发布 Stable（2026-11-26）/, `${path} must say published stable`);
  assert.match(notes, /PUBLISHED STABLE/, `${path} must carry the English published marker`);
  assert.ok(notes.includes(EVIDENCE.date), `${path} must record the publication date`);
  assert.ok(notes.includes(`GitHub Release id \`${EVIDENCE.githubReleaseId}\``), `${path} must record the GitHub release id`);
  assert.ok(notes.includes(EVIDENCE.tagObject), `${path} must record the annotated tag object`);
  assert.ok(notes.includes(EVIDENCE.commit), `${path} must record the exact source commit`);
  assert.ok(notes.includes(EVIDENCE.githubPublishedAt), `${path} must record the GitHub publish time`);
  assert.ok(notes.includes(EVIDENCE.npmPublishedAt), `${path} must record the npm publish time`);
  assert.ok(notes.includes(EVIDENCE.t0), `${path} must record T0`);
  assert.ok(notes.includes(EVIDENCE.assetName), `${path} must record the exact asset name`);
  assert.ok(notes.includes(`${EVIDENCE.assetBytes} B`), `${path} must record the exact asset size`);
  assert.ok(notes.includes(EVIDENCE.assetSha256), `${path} must record the asset SHA-256`);
  assert.ok(notes.includes(EVIDENCE.npmShasum), `${path} must record the npm shasum`);
  assert.ok(notes.includes(EVIDENCE.npmIntegrity), `${path} must record the npm integrity`);
  assert.match(notes, /`latest`[^\n]{0,30}`next`[^\n]{0,40}`0\.9\.0`/, `${path} must record both dist-tags`);
  assert.match(notes, /HOLD/, `${path} must retain the independent readback HOLD`);
  assert.match(notes, /独立[^\n]{0,40}(?:读回|字节)[^\n]{0,40}(?:HOLD|未完成|仍未)/, `${path} must explain the independent byte readback limitation`);

  // The main CI first RED / retry is evidence, not a silent all-green claim.
  assert.ok(notes.includes(MAIN_CI_ATTEMPT1), `${path} must link the first main CI attempt`);
  assert.ok(notes.includes(MAIN_CI_ATTEMPT2), `${path} must link the retry`);
  assert.match(notes, /INCONCLUSIVE/, `${path} must classify the flake as INCONCLUSIVE`);
  assert.match(notes, /NOT_REPRODUCED/, `${path} must record the non-reproduction`);

  for (const host of HOSTS) {
    assert.ok(notes.includes(host), `${path} must list the exact ${host} Host pin`);
  }
  for (const token of [
    'W6B',
    '/terminal',
    'TITLE.G1',
    '/rename',
    '/context',
    'Overview',
    'Composition',
    'cache-only',
    'EVIDENCE_LIMITED',
    'NOT_MEASURED',
  ]) {
    assert.ok(notes.includes(token), `${path} must document ${token}`);
  }
  for (const token of [
    'Windows 10',
    'Windows 11',
    'Windows Terminal',
    '九条 Host',
    '六条 ConPTY',
    'characterization',
  ]) {
    assert.ok(notes.includes(token), `${path} must document ${token}`);
  }
  assert.ok(notes.includes(ZH_DISCLOSURE), 'release notes must carry the Chinese OS disclosure');
  assert.ok(notes.includes(EN_DISCLOSURE), 'release notes must carry the English OS disclosure');
  assert.ok(notes.includes(RED_RUN), 'release notes must link the original RED');
  assert.ok(notes.includes(D5_AUDIT), 'release notes must link the D5 audit');

  // Explicit exclusions, by name. No new user feature is claimed.
  for (const token of [
    '#49',
    '#50',
    '#73',
    '/search',
    'Picker',
    'F2',
    'archive',
    'restore',
    'delete',
    'reset',
    'AgentTeam',
  ]) {
    assert.ok(notes.includes(token), `${path} must list the ${token} exclusion`);
  }

  // 0.9.1 is mentioned only as a future line, never as a release.
  assert.ok(notes.includes(FUTURE), `${path} must distinguish the future 0.9.1 line`);
  assert.doesNotMatch(
    notes,
    /v0\.9\.1|releases\/tag\/v0\.9\.1|dsh-ssh-tui@0\.9\.1/,
    `${path} must not hardcode an unapproved 0.9.1 release`,
  );
  assert.doesNotMatch(
    notes,
    /0\.9\.0[^\n]{0,40}(?:未发布|not published|unpublished)/i,
    `${path} must not describe the immutable 0.9.0 release as unpublished`,
  );
});

test('CHANGELOG records published 0.9.0, historical rc.1 and unreleased 0.9.1', () => {
  const changelog = read('CHANGELOG.md');
  assert.match(
    changelog,
    /## 0\.9\.1 — 开发中（未发布）/,
    'CHANGELOG.md must mark 0.9.1 as unreleased development',
  );
  assert.match(
    changelog,
    /## 0\.9\.0 — 稳定版（2026-11-26）/,
    'CHANGELOG.md must record 0.9.0 as the published stable',
  );
  assert.match(
    changelog,
    /docs\/release-notes-0\.9\.0\.md/,
    'CHANGELOG.md must link the 0.9.0 release notes',
  );
  assert.match(
    changelog,
    /## 0\.9\.0-rc\.1 — 已发布预发布 \/ 历史（2026-11-24）/,
    'CHANGELOG.md must mark 0.9.0-rc.1 as the published historical prerelease',
  );
  assert.match(
    changelog,
    /docs\/release-notes-0\.9\.0-rc\.1\.md/,
    'CHANGELOG.md must keep the historical rc.1 release-notes link',
  );
  for (const token of ['/terminal', '/rename', '/context', 'Windows Server', 'EVIDENCE_LIMITED']) {
    assert.ok(changelog.includes(token), `CHANGELOG.md must mention ${token}`);
  }

  // The pre-publication candidate section must not survive as the current one.
  assert.doesNotMatch(
    changelog,
    /## 0\.9\.0 — 稳定候选准备（未发布）/,
    'CHANGELOG.md still labels published 0.9.0 as an unpublished candidate',
  );
  assert.doesNotMatch(
    changelog,
    /## 0\.9\.0 — 稳定版$/m,
    'CHANGELOG.md must not invent a second, undated 0.9.0 stable section',
  );

  const futureStart = changelog.indexOf('## 0.9.1');
  const releaseStart = changelog.indexOf('## 0.9.0 — 稳定版');
  assert.ok(futureStart >= 0 && releaseStart > futureStart, '0.9.1 must precede 0.9.0 in the log');
  const futureSection = changelog.slice(futureStart, releaseStart);
  assert.match(futureSection, /未发布/, 'the 0.9.1 section must say it is unreleased');
  assert.doesNotMatch(
    futureSection,
    /已发布|published stable|release id/i,
    'the 0.9.1 section must not claim a publication',
  );
});

test('candidate evidence report keeps the required historical sections audit-visible', () => {
  const path = 'docs/rc1-candidate-evidence.md';
  assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} must exist`);
  const evidence = read(path);
  for (const heading of [
    '## Source',
    '## Local validation',
    '## CI',
    '## Packs',
    '## Upgrade and rollback',
    '## Limitations',
  ]) {
    assert.ok(evidence.includes(heading), `${path} must keep the ${heading} section`);
  }
  assert.match(evidence, /EVIDENCE_LIMITED/, 'evidence must keep upstream provenance limitations');
  assert.match(evidence, /NOT_MEASURED/, 'evidence must keep not-measured items explicit');
});
