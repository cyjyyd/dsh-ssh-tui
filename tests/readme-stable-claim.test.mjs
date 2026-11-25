// F1 regression guard: the docs must distinguish the *published* 0.8.6
// Stable (seven frozen Host versions), the *published historical* 0.9.0-rc.1
// prerelease, and this *unpublished* 0.9.0 stable candidate, whose package
// identity is now 0.9.0.
//
// The pre-fix READMEs claimed 0.8.5 "remains the current stable release"
// (EN) / "0.8.5 仍是当前稳定版" (ZH). That is the defect this test pins.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('READMEs distinguish published 0.8.6 Stable from the unpublished 0.9.0 candidate', () => {
  const en = read('README.en.md');
  const zh = read('README.md');
  const pkg = JSON.parse(read('package.json'));

  // RED anchor (exact pre-fix strings).
  assert.ok(
    !en.includes('`0.8.5` remains the current stable release'),
    'README.en.md still says 0.8.5 remains the current stable release',
  );
  assert.ok(
    !zh.includes('0.8.5 仍是当前稳定版'),
    'README.md still says 0.8.5 仍是当前稳定版',
  );

  // Broader form: 0.8.5 must never be labelled the current stable.
  assert.doesNotMatch(
    en,
    /0\.8\.5[^\n]{0,80}(?:is|remains)\s+the\s+current\s+stable/i,
    'README.en.md equates 0.8.5 with the current stable release',
  );
  assert.doesNotMatch(
    zh,
    /0\.8\.5[^\n]{0,80}仍是当前稳定版/,
    'README.md equates 0.8.5 with the current stable release',
  );

  // Positive contract: published 0.8.6 Stable, seven Host versions.
  assert.match(
    en,
    /current published stable release is `0\.8\.6`/i,
    'README.en.md must name 0.8.6 as the current published stable',
  );
  assert.match(
    en,
    /seven (?:frozen )?Host versions/i,
    'README.en.md must state the seven-Host stable scope',
  );
  assert.match(
    zh,
    /当前已发布的稳定版是 `0\.8\.6`/,
    'README.md must name 0.8.6 as the current published stable',
  );
  assert.match(
    zh,
    /七个冻结 Host 版本/,
    'README.md must state the seven-Host stable scope',
  );

  // Negative scope: the 0.9.0 candidate is unpublished.
  assert.equal(pkg.version, '0.9.0', 'the stable candidate must carry the 0.9.0 identity');
  assert.match(en, /unreleased/i, 'README.en.md must call the 0.9.0 candidate unpublished');
  assert.match(
    en,
    /package identity `0\.9\.0`/,
    'README.en.md must state the candidate package identity',
  );
  assert.match(zh, /尚未公开发布/, 'README.md must call the 0.9.0 candidate unpublished');
  assert.match(
    zh,
    /package identity `0\.9\.0`/,
    'README.md must state the candidate package identity',
  );

  // Historical state: 0.9.0-rc.1 is already published as a prerelease, while
  // 0.9.0 itself remains unpublished.
  assert.match(
    en,
    /published prerelease is `0\.9\.0-rc\.1`/i,
    'README.en.md must record 0.9.0-rc.1 as the published historical prerelease',
  );
  assert.match(
    zh,
    /已发布的预发布是 `0\.9\.0-rc\.1`/,
    'README.md must record 0.9.0-rc.1 as the published historical prerelease',
  );
});

// The 0.9 matrix added four Linux legs and four ConPTY legs. README.en.md was
// updated with the new count, README.md was not: it still told Chinese readers
// that CI covers "four host versions". The two READMEs must agree on the matrix
// the workflow actually runs (tests/workflow.test.mjs owns the matrix itself).
test('READMEs agree on the nine-Linux / six-ConPTY CI matrix', () => {
  const en = read('README.en.md');
  const zh = read('README.md');

  assert.match(
    en,
    /nine host versions plus the six-line ConPTY subset/i,
    'README.en.md must state the nine-Linux/six-ConPTY CI matrix',
  );
  assert.match(zh, /九条 Host 线/, 'README.md must state the nine-Linux CI matrix');
  assert.match(zh, /六条 ConPTY 线/, 'README.md must state the six-ConPTY CI matrix');
  assert.doesNotMatch(
    zh,
    /四个宿主版本/,
    'README.md still tells Chinese readers that CI covers four host versions',
  );
});
