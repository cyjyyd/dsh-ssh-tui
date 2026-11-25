// REL090-STABLE.PREP4: the release identity is a state machine, not one fixed
// version string. This branch now carries the *unpublished* 0.9.0 stable
// candidate; 0.9.0-rc.1 is a *published historical prerelease*, and 0.8.6
// remains the current published Stable.
//
// The S1-E development tree intentionally stayed at package version 0.8.5 and
// described rc.4/rc.5 as COMPAT_ADMISSION_PENDING. That was correct for an
// unreleased development candidate and wrong for the 0.9.0-rc.1 freeze
// candidate; it is likewise wrong for the 0.9.0 stable candidate.
//
// After the state-driven promotion this test pins:
//   - package/lock identity 0.9.0 and the exact nine-Host union;
//   - the README distinction between published 0.8.6 Stable, the published
//     historical 0.9.0-rc.1 prerelease, and this unpublished 0.9.0 candidate;
//   - the conspicuous Chinese + English Windows Server exclusion for 0.9.0,
//     including the original RED and the bounded D5 audit;
//   - the 0.9.0 release notes, the preserved rc.1 historical notes, the
//     CHANGELOG and the candidate evidence inventory.

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
const CANDIDATE = '0.9.0';
const RC1 = '0.9.0-rc.1';
const RED_RUN =
  'https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/44881356855/job/136777141174';
const D5_AUDIT =
  'https://github.com/cyjyyd/dsh-ssh-tui/pull/89#issuecomment-7090676703';
const ZH_DISCLOSURE =
  'Windows Server 系列（含 Server 2025）不在 0.9.0 支持范围。历史 Windows Server 2025 question-wait 双换行 CI RED 仍保留，根因未明；不保证 Server 兼容性。';
const EN_DISCLOSURE =
  'Windows Server family (including Server 2025) is outside the supported scope of 0.9.0. The historical Windows Server 2025 question-wait double-newline CI RED remains, with root cause unknown; Server compatibility is not guaranteed.';
const ZH_RC1_DISCLOSURE =
  'Windows Server 系列（含 Server 2025）不在 0.9.0-rc.1 支持范围。历史 Windows Server 2025 question-wait 双换行 CI RED 仍保留，根因未明；不保证 Server 兼容性。';
const EN_RC1_DISCLOSURE =
  'Windows Server family (including Server 2025) is outside the supported scope of 0.9.0-rc.1. The historical Windows Server 2025 question-wait double-newline CI RED remains, with root cause unknown; Server compatibility is not guaranteed.';

test('package identity is the unpublished 0.9.0 stable candidate with nine Hosts', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));

  assert.equal(pkg.version, CANDIDATE, 'package.json must identify the 0.9.0 stable candidate');
  assert.equal(lock.version, CANDIDATE, 'package-lock.json root version must match the package');
  assert.equal(
    lock.packages['']?.version,
    CANDIDATE,
    'package-lock.json packages[""].version must match the package',
  );

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
    'exactly nine Host releases are compatible for this candidate',
  );
});

test('READMEs distinguish published 0.8.6 / historical rc.1 from the unpublished 0.9.0 candidate', () => {
  const zh = read('README.md');
  const en = read('README.en.md');

  for (const [name, text] of [['README.md', zh], ['README.en.md', en]]) {
    assert.ok(
      !text.includes('COMPAT_ADMISSION_PENDING'),
      `${name} still describes rc.4/rc.5 admission as pending`,
    );
    assert.match(
      text,
      /package identity `0\.9\.0`/,
      `${name} must name the ${CANDIDATE} candidate identity`,
    );
    assert.ok(
      text.includes(RC1),
      `${name} must record the published historical ${RC1} prerelease`,
    );
    assert.match(text, /EVIDENCE_LIMITED/, `${name} must keep the evidence limitation label`);
    assert.match(
      text,
      /NOT_MEASURED|NOT MEASURED/,
      `${name} must keep the not-measured boundary explicit`,
    );
  }

  // Published stable stays 0.8.6 / seven frozen Hosts.
  assert.match(zh, /当前已发布的稳定版是 `0\.8\.6`/, 'README.md must keep 0.8.6 as published stable');
  assert.match(zh, /七个冻结 Host 版本/, 'README.md must keep the seven-Host stable scope');
  assert.match(
    en,
    /current published stable release is `0\.8\.6`/i,
    'README.en.md must keep 0.8.6 as published stable',
  );
  assert.match(en, /seven (?:frozen )?Host versions/i, 'README.en.md must keep seven Hosts stable');

  // The already-published rc.1 is history, not the current candidate.
  assert.match(
    zh,
    /已发布的预发布是 `0\.9\.0-rc\.1`/,
    'README.md must record 0.9.0-rc.1 as the published historical prerelease',
  );
  assert.match(
    en,
    /published prerelease is `0\.9\.0-rc\.1`/i,
    'README.en.md must record 0.9.0-rc.1 as the published historical prerelease',
  );

  // Candidate-only qualified admission, not public support and not a release.
  assert.match(zh, /有限技术准入/, 'README.md must describe candidate-only qualified admission');
  assert.match(
    en,
    /qualified technical admission/i,
    'README.en.md must describe candidate-only qualified admission',
  );
  assert.match(zh, /尚未公开发布/, 'README.md must call the 0.9.0 candidate unpublished');
  assert.match(en, /unreleased/i, 'README.en.md must call the 0.9.0 candidate unreleased');
  assert.doesNotMatch(zh, /当前稳定版是 `0\.9\.0`/, 'README.md must not call 0.9.0 stable');
  assert.doesNotMatch(en, /0\.9\.0 is the current stable/i, 'README.en.md must not call 0.9.0 stable');
  assert.doesNotMatch(zh, /0\.9\.0 已发布/, 'README.md must not claim 0.9.0 was published');
  assert.doesNotMatch(en, /0\.9\.0 (?:is|has been) released/i, 'README.en.md must not claim 0.9.0 was published');
  assert.doesNotMatch(
    zh,
    /package 版本有意保持 `0\.8\.5`/,
    'README.md still keeps the development 0.8.5 identity',
  );
  assert.doesNotMatch(
    en,
    /package version intentionally remains `0\.8\.5`/,
    'README.en.md still keeps the development 0.8.5 identity',
  );
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
});

test('release notes inventory the 0.9.0 candidate accurately', () => {
  const path = 'docs/release-notes-0.9.0.md';
  assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} must exist`);
  const notes = read(path);

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
  for (const host of HOSTS) {
    assert.ok(notes.includes(host), `${path} must list the exact ${host} Host pin`);
  }
  assert.match(notes, /Windows 10/, 'release notes must state the supported desktop Windows scope');
  assert.match(notes, /Windows 11/, 'release notes must state the supported desktop Windows scope');
  assert.match(notes, /Windows Terminal/, 'release notes must name a supported Windows terminal');
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
  assert.match(notes, /not published|unpublished|UNRELEASED/i, 'release notes must say it is unpublished');
});

test('CHANGELOG records the 0.9.0 candidate and rc.1 history without claiming publication', () => {
  const changelog = read('CHANGELOG.md');
  assert.match(
    changelog,
    /## 0\.9\.0 — 稳定候选准备/,
    'CHANGELOG.md must have a 0.9.0 stable-candidate preparation section',
  );
  assert.match(
    changelog,
    /docs\/release-notes-0\.9\.0\.md/,
    'CHANGELOG.md must link the 0.9.0 release notes',
  );
  assert.match(
    changelog,
    /## 0\.9\.0-rc\.1 — 已发布预发布/,
    'CHANGELOG.md must mark 0.9.0-rc.1 as the published historical prerelease',
  );
  assert.match(
    changelog,
    /docs\/release-notes-0\.9\.0-rc\.1\.md/,
    'CHANGELOG.md must keep the historical rc.1 release-notes link',
  );
  for (const token of ['/terminal', '/rename', '/context', 'Windows Server']) {
    assert.ok(changelog.includes(token), `CHANGELOG.md must mention ${token}`);
  }
  assert.doesNotMatch(changelog, /## 0\.9\.0 — 稳定版/, 'CHANGELOG.md must not invent a 0.9.0 stable release');
  assert.doesNotMatch(
    changelog,
    /## 0\.9\.0-rc\.1 — 冻结候选（未发布）/,
    'CHANGELOG.md must not leave rc.1 labelled as an unpublished candidate',
  );
});

test('candidate evidence report keeps the required sections audit-visible', () => {
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
