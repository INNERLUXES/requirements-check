import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { logicalLines, parseRequirement, parseRequirementsText, readRequirements, referenceKind, isInsecureUrl, readBounded, LIMITS } from '../src/index.js';
import { withFiles, tree, H } from './helpers.js';

test('logicalLines joins backslash continuations, removes comments and keeps the first line number', () => {
  const lines = logicalLines([
    '# a comment',
    '',
    'example-a==1.0 \\',
    '    --hash=sha256:aa \\',
    '    --hash=sha256:bb',
    '    # via -r requirements.in',
    'example-b @ https://files.example.org/b-1.0.whl#sha256=cc  # trailing comment',
    'example-c==2.0\t# tab before the comment',
    'example-d==3.0 \\'
  ].join('\r\n'));
  assert.deepEqual(lines, [
    { text: 'example-a==1.0     --hash=sha256:aa     --hash=sha256:bb', line: 3 },
    { text: 'example-b @ https://files.example.org/b-1.0.whl#sha256=cc', line: 7 },
    { text: 'example-c==2.0', line: 8 },
    { text: 'example-d==3.0', line: 9 }
  ]);
});

test('parseRequirement: names, extras, specifiers with or without parentheses, and environment markers', () => {
  const r = parseRequirement('Example_Web.Framework[async, Mail] (>=3.0, <4) ; python_version < "3.13" and sys_platform != "win32"');
  assert.equal(r.ok, true);
  assert.equal(r.name, 'Example_Web.Framework');
  assert.equal(r.normalized, 'example-web-framework');
  assert.deepEqual(r.extras, ['async', 'Mail']);
  assert.deepEqual(r.specs.map((s) => s.op), ['>=', '<']);
  assert.equal(r.specifier, '>=3.0, <4');
  assert.equal(r.pin, null);
  assert.equal(r.marker, 'python_version < "3.13" and sys_platform != "win32"');
  assert.equal(parseRequirement('example-a==1.4.2').pin, '1.4.2');
  assert.equal(parseRequirement('example-a===1.4.2-custom').pin, '1.4.2-custom');
  assert.equal(parseRequirement('example-a').specifier, '');
  assert.equal(parseRequirement('example-a;python_version>"3"').marker, 'python_version>"3"');
});

test('parseRequirement: direct references by name @ URL, by URL with #egg=, by archive name and by path', () => {
  const at = parseRequirement('example-pdf @ git+https://git.example.org/pdf.git@v1.3.0 ; python_version >= "3.10"');
  assert.deepEqual([at.name, at.url, at.refKind, at.marker, at.pin], ['example-pdf', 'git+https://git.example.org/pdf.git@v1.3.0', 'vcs', 'python_version >= "3.10"', null]);
  const semi = parseRequirement('example-x @ https://files.example.org/x.whl;v=1');
  assert.deepEqual([semi.url, semi.marker], ['https://files.example.org/x.whl;v=1', null]);
  const egg = parseRequirement('git+ssh://git@git.example.org/team/lib.git#egg=example-lib');
  assert.deepEqual([egg.name, egg.refKind], ['example-lib', 'vcs']);
  const archive = parseRequirement('https://files.example.org/example_tool-0.4.1.tar.gz#sha256=abcd');
  assert.deepEqual([archive.name, archive.refKind, archive.urlHashes], ['example_tool', 'url', ['sha256:abcd']]);
  const path = parseRequirement('./vendor/example-legacy[extra]');
  assert.deepEqual([path.name, path.refKind, path.extras], ['example-legacy', 'path', ['extra']]);
  assert.equal(parseRequirement('C:\\wheels\\example_a-1.0-py3-none-any.whl').refKind, 'path');
  assert.equal(parseRequirement('file:///srv/wheels/x.whl').refKind, 'path');
});

test('parseRequirement refuses what pip would refuse instead of guessing', () => {
  for (const bad of ['-bad-name==1.0', 'example-a==1.0.x', 'example-a >> 2', 'example-a[bad extra]==1', 'example-a==1.0 ;', 'https://files.example.org/x.whl extra']) {
    assert.equal(parseRequirement(bad).ok, false, bad);
  }
});

test('options lines: includes, indexes, find-links, trusted hosts, flags and every spelling of them', () => {
  const entries = parseRequirementsText([
    '-r base.txt',
    '--requirement=more.txt',
    '-rshort.txt',
    '-c constraints.txt',
    '--constraint other.txt',
    '-i https://pypi.example.org/simple',
    '--index-url=https://pypi.example.org/simple',
    '--extra-index-url https://extra.example.org/simple',
    '-f ./wheels',
    '--trusted-host pypi.example.org',
    '--require-hashes',
    '--no-index',
    '--pre',
    '--frobnicate',
    '-e ./vendor/example-lib'
  ].join('\n'), 'r.txt');
  assert.deepEqual(entries.filter((e) => e.type === 'include').map((e) => [e.kind, e.target]), [
    ['requirement', 'base.txt'], ['requirement', 'more.txt'], ['requirement', 'short.txt'], ['constraint', 'constraints.txt'], ['constraint', 'other.txt']
  ]);
  assert.deepEqual(entries.filter((e) => e.type === 'option').map((e) => [e.name, e.value]), [
    ['index-url', 'https://pypi.example.org/simple'], ['index-url', 'https://pypi.example.org/simple'], ['extra-index-url', 'https://extra.example.org/simple'],
    ['find-links', './wheels'], ['trusted-host', 'pypi.example.org'], ['require-hashes', null], ['no-index', null], ['pre', null]
  ]);
  assert.deepEqual(entries.filter((e) => e.type === 'unknown-option').map((e) => [e.text, e.line]), [['--frobnicate', 14]]);
  const editable = entries.find((e) => e.type === 'requirement');
  assert.deepEqual([editable.req.editable, editable.req.url, editable.req.name, editable.line], [true, './vendor/example-lib', 'example-lib', 15]);
  assert.throws(() => parseRequirementsText('-r', 'r.txt'), /r\.txt:1: -r needs a value/);
});

test('--hash options: both spellings, several per requirement, lower-cased; a malformed hash stops the run', () => {
  const [e] = parseRequirementsText(`example-a==1.0 --hash=SHA256:${'A'.repeat(64)} --hash ${H('b')} --config-settings x=1`, 'r.txt');
  assert.deepEqual(e.req.hashes, [H('a'), H('b')]);
  assert.equal(e.req.hashOptions, 2);
  assert.deepEqual(e.unknown, []);
  assert.throws(() => parseRequirementsText('example-a==1.0\nexample-b==1.0 --hash=sha256', 'r.txt'), /r\.txt:2: "--hash sha256" is not algorithm:hex-digest/);
  assert.throws(() => parseRequirementsText('example-b==1.0 --hash=crc32:abcd', 'r.txt'), /not algorithm:hex-digest/);
  assert.throws(() => parseRequirementsText('example-a==1.0.x', 'r.txt'), /r\.txt:1: cannot read the requirement "example-a==1\.0\.x"/);
});

test('readRequirements follows -r and -c relative to the file that names them, and reads a shared file once', async () => {
  const t = await tree({
    'requirements.txt': '-r requirements/base.txt\n-c requirements/constraints.txt\nexample-web==1.0\n',
    'requirements/base.txt': '-r common.txt\nexample-db==2.0\n',
    'requirements/common.txt': 'example-log==3.0\n',
    'requirements/constraints.txt': '-r common.txt\nexample-db<3\n'
  });
  assert.deepEqual(t.files.map((f) => [f.file, f.kind, f.depth]), [
    ['requirements.txt', 'requirements', 0],
    ['requirements/base.txt', 'requirements', 1],
    ['requirements/common.txt', 'requirements', 2],
    ['requirements/constraints.txt', 'constraints', 1]
  ]);
  assert.deepEqual(t.requirements.map((r) => `${r.name}@${r.file}:${r.line}`), ['example-log@requirements/common.txt:1', 'example-db@requirements/base.txt:2', 'example-web@requirements.txt:3']);
  assert.deepEqual(t.constraints.map((r) => [r.name, r.constraint]), [['example-db', true]]);
});

test('include cycles are reported with the chain of files', async () => {
  await assert.rejects(() => tree({ 'a.txt': '-r b.txt\n', 'b.txt': '-r sub/c.txt\n', 'sub/c.txt': '-r ../a.txt\n' }), /a\.txt: the includes form a cycle \(a\.txt -> b\.txt -> sub\/c\.txt -> a\.txt\)/);
  await assert.rejects(() => tree({ 'a.txt': '-c a.txt\n' }), /cycle \(a\.txt -> a\.txt\)/);
});

test('an include that leaves the folder of the starting file is refused, as written and after links', async () => {
  await withFiles({ 'outside.txt': 'example-x==1.0\n', 'app/requirements.txt': '-r ../outside.txt\n' }, async (dir) => {
    await assert.rejects(() => readRequirements(join(dir, 'app', 'requirements.txt'), { display: 'app/requirements.txt' }), /outside\.txt: refusing to read a file outside app, the folder of app\/requirements\.txt/);
  });
  await withFiles({ 'secret.txt': 'x\n' }, async (outer) => {
    await withFiles({ 'requirements.txt': `-r ${join(outer, 'secret.txt')}\n` }, async (dir) => {
      await assert.rejects(() => readRequirements(join(dir, 'requirements.txt'), { display: 'requirements.txt' }), /refusing to read a file outside/);
    });
  });
});

test('a missing include names the file and line; an include by URL is recorded and never fetched', async () => {
  await assert.rejects(() => tree({ 'requirements.txt': 'example-a==1.0\n-r missing.txt\n' }), /requirements\.txt:2: the included file missing\.txt does not exist/);
  const t = await tree({ 'requirements.txt': '-r https://files.example.org/base.txt\n-c http://files.example.org/c.txt\n' });
  assert.deepEqual(t.remoteIncludes.map((r) => [r.kind, r.url, r.line]), [['requirement', 'https://files.example.org/base.txt', 1], ['constraint', 'http://files.example.org/c.txt', 2]]);
  assert.deepEqual(t.files.length, 1);
});

test('limits: nested includes, requirement lines and file size stop the run', async () => {
  const chain = {};
  for (let i = 0; i < 6; i += 1) chain[`r${i}.txt`] = `-r r${i + 1}.txt\n`;
  chain['r6.txt'] = 'example-a==1.0\n';
  await assert.rejects(() => tree(chain, { main: 'r0.txt', limits: { ...LIMITS, maxIncludeDepth: 4 } }), /more than 4 nested -r \/ -c includes/);
  assert.equal((await tree(chain, { main: 'r0.txt' })).requirements.length, 1);
  const many = Array.from({ length: 30 }, (_, i) => `example-p${i}==1.0`).join('\n');
  await assert.rejects(() => tree({ 'requirements.txt': many }, { limits: { ...LIMITS, maxRequirements: 20 } }), /more than 20 requirement lines/);
  await withFiles({ 'big.txt': 'x'.repeat(5000) }, async (dir) => {
    await assert.rejects(() => readBounded(join(dir, 'big.txt'), { ...LIMITS, maxFileBytes: 1000 }), /5000 bytes is over the .* MB limit/);
    await assert.rejects(() => readBounded(dir), /not a file/);
  });
  assert.equal(LIMITS.maxFileBytes, 50 * 1024 * 1024);
  assert.equal(LIMITS.maxRequirements, 100_000);
  assert.equal(LIMITS.maxIncludeDepth, 50);
});

test('referenceKind and isInsecureUrl', () => {
  assert.equal(referenceKind('git+https://git.example.org/a.git'), 'vcs');
  assert.equal(referenceKind('hg+https://hg.example.org/a'), 'vcs');
  assert.equal(referenceKind('git://git.example.org/a.git'), 'vcs');
  assert.equal(referenceKind('https://files.example.org/a.whl'), 'url');
  assert.equal(referenceKind('./a'), 'path');
  for (const u of ['http://x.example.org/simple', 'git://x.example.org/a.git', 'git+http://x.example.org/a.git', 'ftp://x.example.org/a.tgz', 'svn://x.example.org/a']) assert.ok(isInsecureUrl(u), u);
  for (const u of ['https://x.example.org/simple', 'git+https://x.example.org/a.git', 'git+ssh://git@x.example.org/a.git', './wheels']) assert.ok(!isInsecureUrl(u), u);
});
