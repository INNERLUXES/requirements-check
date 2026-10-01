import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINDINGS, SEVERITIES, RANK, DEFAULTS, isFindingId, meetsThreshold, maskCredentials, safeText, globMatch, isDevFile, parseConfig } from '../src/index.js';
import { check, ids, find, H } from './helpers.js';

const at = (report, id) => find(report, id).map((f) => [f.package, f.severity, `${f.file}:${f.line}`]);

test('every check has an id and known severities, and the list is complete', () => {
  assert.deepEqual(FINDINGS.map((f) => f.id), [
    'non-index-source', 'insecure-url', 'unpinned', 'missing-hash', 'duplicate-requirement', 'conflicting-constraint',
    'lock-mismatch', 'extra-index', 'weak-hash', 'marker-note'
  ]);
  for (const f of FINDINGS) for (const s of f.severity.split(' / ')) assert.ok(SEVERITIES.includes(s), f.id);
  assert.ok(isFindingId('weak-hash'));
  assert.ok(!isFindingId('toString'));
  assert.ok(RANK.error < RANK.warning && RANK.warning < RANK.info);
  assert.ok(meetsThreshold('error', 'warning'));
  assert.ok(!meetsThreshold('warning', 'error'));
  assert.ok(!meetsThreshold('info', 'warning'));
  assert.equal(DEFAULTS.limit, 200);
});

test('a pinned, hashed requirements file has no findings and passes the gate', async () => {
  const r = await check({ 'requirements.txt': `example-a==1.0 --hash=${H('a')}\nexample-b==2.0 \\\n  --hash=${H('b')}\n` });
  assert.deepEqual(r.findings, []);
  assert.equal(r.gate.pass, true);
  assert.deepEqual([r.summary.packages, r.summary.pinned, r.summary.hashed, r.summary.direct], [2, 2, 2, 0]);
});

test('unpinned: an error in deployment files, a warning in development files and *.in files', async () => {
  const files = {
    'requirements.txt': 'example-a>=1.0\nexample-b\nexample-c==1.*\nexample-d==1.0\nexample-e===1.0-x\n',
    'requirements-dev.txt': 'example-lint~=6.0\n',
    'requirements.in': 'example-web\n',
    'ci-requirements.txt': 'example-ci>=1\n'
  };
  const r = await check(files);
  assert.deepEqual(at(r, 'unpinned'), [
    ['example-ci', 'error', 'ci-requirements.txt:1'],
    ['example-a', 'error', 'requirements.txt:1'],
    ['example-b', 'error', 'requirements.txt:2'],
    ['example-c', 'error', 'requirements.txt:3'],
    ['example-lint', 'warning', 'requirements-dev.txt:1'],
    ['example-web', 'warning', 'requirements.in:1']
  ]);
  assert.match(find(r, 'unpinned')[1].message, /example-a has no exact pin \(">=1\.0"\): pip installs the newest version/);
  assert.match(find(r, 'unpinned')[2].message, /\(any version\)/);
  const extra = await check(files, { devPatterns: [...DEFAULTS.devPatterns, 'ci-*'] });
  assert.deepEqual(find(extra, 'unpinned').filter((f) => f.file === 'ci-requirements.txt').map((f) => f.severity), ['warning']);
});

test('missing-hash: an error in hash-checking mode, a warning with --want-hashes, silent otherwise', async () => {
  const mixed = await check({ 'requirements.txt': `example-a==1.0 --hash=${H('a')}\nexample-b==1.0\n` });
  assert.deepEqual(at(mixed, 'missing-hash'), [['example-b', 'error', 'requirements.txt:2']]);
  assert.match(find(mixed, 'missing-hash')[0].message, /other requirements have hashes, which turns on pip's hash-checking mode/);
  const required = await check({ 'requirements.txt': '--require-hashes\nexample-a==1.0\n' });
  assert.match(find(required, 'missing-hash')[0].message, /--require-hashes is set/);
  const included = await check({ 'requirements.txt': '-r base.txt\nexample-a==1.0\n', 'base.txt': '--require-hashes\n' }, { only: ['requirements.txt'] });
  assert.deepEqual(at(included, 'missing-hash'), [['example-a', 'error', 'requirements.txt:2']]);
  const plain = { 'requirements.txt': 'example-a==1.0\nexample-b @ https://files.example.org/b-1.0.whl#sha256=abcd\n' };
  assert.deepEqual(find(await check(plain), 'missing-hash'), [], 'a URL fragment alone does not turn hash checking on');
  assert.deepEqual(at(await check(plain, { wantHashes: true }), 'missing-hash'), [['example-a', 'warning', 'requirements.txt:1']]);
});

test('weak-hash: md5 and sha1 in requirements files and lock files', async () => {
  const r = await check({
    'requirements.txt': `example-a==1.0 --hash=sha1:${'a'.repeat(40)} --hash=${H('b')}\nexample-b @ https://files.example.org/b.tar.gz#md5=${'c'.repeat(32)}\n`,
    'uv.lock': `[[package]]\nname = "example-c"\nversion = "1.0"\nsource = { registry = "https://pypi.org/simple" }\nsdist = { hash = "md5:${'d'.repeat(32)}" }\n`
  });
  assert.deepEqual(at(r, 'weak-hash'), [['example-a', 'warning', 'requirements.txt:1'], ['example-b', 'warning', 'requirements.txt:2'], ['example-c', 'warning', 'uv.lock:1']]);
  assert.match(find(r, 'weak-hash')[0].message, /a hash made with SHA-1, which can be forged/);
  assert.match(find(r, 'weak-hash')[1].message, /made with MD5/);
});

test('non-index-source: version control, archive URLs, local paths, editable installs and remote includes; allowDirect accepts a prefix', async () => {
  const files = {
    'requirements.txt': [
      'example-a @ git+https://git.example.org/team/a.git@v1.0',
      'https://files.example.org/example_b-1.0.tar.gz',
      './wheels/example_c-1.0-py3-none-any.whl',
      '-e ./libs/example-d',
      '-r https://files.example.org/more.txt',
      'example-e==1.0'
    ].join('\n')
  };
  const r = await check(files);
  assert.deepEqual(find(r, 'non-index-source').map((f) => f.line), [1, 2, 3, 4, 5]);
  assert.ok(find(r, 'non-index-source').every((f) => f.severity === 'error'));
  const [vcs, url, path, editable, include] = find(r, 'non-index-source').map((f) => f.message);
  assert.match(vcs, /example-a comes from a version control repository \(git\+https:\/\/git\.example\.org\/team\/a\.git@v1\.0\)/);
  assert.match(url, /example_b comes from an archive URL/);
  assert.match(path, /example_c comes from a local path/);
  assert.match(editable, /example-d is installed in editable mode from \.\/libs\/example-d/);
  assert.match(include, /includes a requirements file from a URL, which pip downloads at install time and this tool does not read/);
  assert.deepEqual(find(r, 'unpinned'), [], 'direct references are reported once, not as unpinned too');
  const allowed = await check(files, { config: { allowDirect: ['git+https://git.example.org/team/', './libs/'] } });
  assert.deepEqual(find(allowed, 'non-index-source').map((f) => f.line), [2, 3, 5]);
});

test('insecure-url: http indexes, find-links and downloads are errors; --trusted-host is a warning', async () => {
  const r = await check({
    'requirements.txt': [
      '--index-url http://pypi.example.internal/simple',
      '--extra-index-url http://extra.example.internal/simple',
      '-f http://files.example.internal/wheels',
      '-f ./wheels',
      '--trusted-host pypi.example.internal',
      'example-a @ git+http://git.example.org/a.git',
      'example-b @ https://files.example.org/b.whl',
      'example-c==1.0'
    ].join('\n')
  });
  assert.deepEqual(find(r, 'insecure-url').map((f) => [f.severity, f.line]), [['error', 1], ['error', 2], ['error', 3], ['error', 6], ['warning', 5]]);
  assert.match(find(r, 'insecure-url')[0].message, /the index http:\/\/pypi\.example\.internal\/simple uses an unencrypted connection/);
  assert.match(find(r, 'insecure-url')[4].message, /--trusted-host pypi\.example\.internal tells pip to accept that host without a valid certificate/);
});

test('extra-index: a warning for each extra index, an error for a private package without a hash', async () => {
  const files = { 'requirements.txt': `--extra-index-url https://pypi.example.internal/simple\nexample-orders-auth==1.2\nexample-orders-db==2.0 --hash=${H('a')}\nexample-web==3.0 --hash=${H('b')}\n` };
  const plain = await check(files);
  assert.deepEqual(at(plain, 'extra-index'), [[null, 'warning', 'requirements.txt:1']]);
  assert.match(find(plain, 'extra-index')[0].message, /dependency confusion/);
  const r = await check(files, { config: { privatePackages: ['Example_Orders-*'] } });
  assert.deepEqual(at(r, 'extra-index'), [['example-orders-auth', 'error', 'requirements.txt:2'], [null, 'warning', 'requirements.txt:1']]);
  const single = await check({ 'requirements.txt': '--index-url https://pypi.example.internal/simple\nexample-orders-auth==1.2\n' }, { config: { privatePackages: ['example-orders-*'] } });
  assert.deepEqual(find(single, 'extra-index'), [], 'one index: nothing to confuse');
});

test('extra-index in lock files: several indexes are a warning, a private package from the public index an error', async () => {
  const lock = `[[package]]
name = "example-orders-auth"
version = "1.2.0"
source = { registry = "https://pypi.org/simple/" }

[[package]]
name = "example-orders-db"
version = "2.0.0"
source = { registry = "https://deploy:t0ken@pypi.example.internal/simple" }
`;
  const r = await check({ 'uv.lock': lock }, { config: { privatePackages: ['example-orders-*'] } });
  assert.deepEqual(at(r, 'extra-index'), [['example-orders-auth', 'error', 'uv.lock:1'], [null, 'warning', 'uv.lock:1']]);
  assert.match(find(r, 'extra-index')[1].message, /locks packages from 2 indexes \(https:\/\/pypi\.org\/simple, https:\/\/pypi\.example\.internal\/simple\)/);
  assert.ok(!JSON.stringify(r).includes('t0ken'));
});

test('lock files: direct sources, http downloads and missing hashes', async () => {
  const lock = `[[package]]
name = "example-app"
version = "0.1.0"
source = { virtual = "." }

[[package]]
name = "example-a"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }
wheels = [{ url = "https://files.example.org/a.whl", hash = "${H('a')}" }]

[[package]]
name = "example-b"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "example-c"
version = "1.0.0"
source = { url = "http://files.example.org/c.tar.gz" }
sdist = { hash = "${H('c')}" }

[[package]]
name = "example-d"
version = "1.0.0"
source = { git = "https://git.example.org/d.git#abc" }
`;
  const r = await check({ 'uv.lock': lock });
  assert.deepEqual(ids(r), ['non-index-source', 'non-index-source', 'insecure-url', 'missing-hash']);
  assert.deepEqual(find(r, 'non-index-source').map((f) => f.package), ['example-c', 'example-d']);
  assert.deepEqual(at(r, 'missing-hash'), [['example-b', 'error', 'uv.lock:12']]);
  assert.equal(r.summary.packages, 4, 'the project itself is not a package');
});

test('duplicate-requirement: different pins across included files, by normalised name; same pins and different markers are fine', async () => {
  const r = await check({
    'requirements.txt': '-r base.txt\nexample_cache.client==4.1.0\nexample-web==3.0\nexample-np==1.0 ; python_version < "3.10"\nexample-log==1.0\n',
    'base.txt': 'Example-Cache-Client==4.0.2\nexample-web==3.0.0\nexample-np==2.0 ; python_version >= "3.10"\nexample-log>=1\n'
  }, { only: ['requirements.txt'] });
  assert.deepEqual(at(r, 'duplicate-requirement'), [['example_cache.client', 'error', 'requirements.txt:2'], ['example-log', 'error', 'requirements.txt:5']]);
  assert.match(find(r, 'duplicate-requirement')[0].message, /is listed again with "==4\.1\.0", after "==4\.0\.2" at base\.txt:1/);
});

test('conflicting-constraint: a pin outside a constraint, or a constraint pin outside the requirement', async () => {
  const r = await check({
    'requirements.txt': '-c constraints.txt\nexample-a==2.8.2\nexample-b>=2\nexample-c==1.5\nexample-d>=1\n',
    'constraints.txt': 'example-a<2.8\nexample-b==1.9\nexample-c>=1,<2\nexample-d==1.4\n'
  }, { only: ['requirements.txt'] });
  assert.deepEqual(at(r, 'conflicting-constraint'), [['example-a', 'error', 'requirements.txt:2'], ['example-b', 'error', 'requirements.txt:3']]);
  assert.match(find(r, 'conflicting-constraint')[0].message, /the pin ==2\.8\.2 is outside the constraint "<2\.8" \(constraints\.txt:1\)/);
  assert.match(find(r, 'conflicting-constraint')[1].message, /the constraint ==1\.9 is outside the requirement ">=2"/);
  assert.equal(r.summary.constraintFiles, 1);
});

test('lock-mismatch: a requirement missing from the lock file or locked outside its specifier', async () => {
  const files = {
    'requirements.txt': 'example-a==1.0\nexample-b>=2\nexample-c==1.0\nexample-win==1.0 ; sys_platform == "win32"\nExample_D==3.0\n',
    'uv.lock': ['example-a', 'example-b', 'example-d'].map((n, i) => `[[package]]\nname = "${n}"\nversion = "${['1.0.0', '1.9', '3.0'][i]}"\nsource = { registry = "https://pypi.org/simple" }\n`).join('\n')
  };
  const r = await check(files, { pair: ['requirements.txt', 'uv.lock'] });
  assert.deepEqual(at(r, 'lock-mismatch'), [['example-b', 'error', 'requirements.txt:2'], ['example-c', 'error', 'requirements.txt:3']]);
  assert.match(find(r, 'lock-mismatch')[0].message, /example-b is locked at 1\.9 in uv\.lock, outside ">=2" in requirements\.txt/);
  assert.match(find(r, 'lock-mismatch')[1].message, /example-c is required in requirements\.txt but not locked in uv\.lock/);
  const unpaired = await check(files);
  assert.deepEqual(find(unpaired, 'lock-mismatch'), []);
  assert.ok(unpaired.notes.some((n) => /only when both are given with --requirements and --lock/.test(n)));
});

test('marker-note lists each requirement limited by an environment marker', async () => {
  const r = await check({ 'requirements.txt': 'example-a==1.0 ; sys_platform == "win32"\nexample-b==1.0\nexample-c==2.0;python_version<"3.11"\n' });
  assert.deepEqual(at(r, 'marker-note'), [['example-a', 'info', 'requirements.txt:1'], ['example-c', 'info', 'requirements.txt:3']]);
  assert.match(find(r, 'marker-note')[0].message, /example-a is installed only where sys_platform == "win32"/);
  assert.equal(r.gate.pass, true);
});

test('parseConfig checks every key, so a typo cannot switch a check off', () => {
  assert.deepEqual(parseConfig(null), { allowDirect: [], privatePackages: [], devPatterns: DEFAULTS.devPatterns, ignore: [] });
  assert.deepEqual(parseConfig({ privatePackages: ['Example_Orders.*'] }).privatePackages, ['example-orders-*']);
  assert.throws(() => parseConfig({ privatePackage: [] }), /config: unknown key "privatePackage"/);
  assert.throws(() => parseConfig({ ignore: [{ check: 'unpined' }] }), /unknown check "unpined"/);
  assert.throws(() => parseConfig({ ignore: [{ reason: 'x' }] }), /needs a "check", a "package" or both/);
  assert.throws(() => parseConfig({ ignore: [{ check: 'unpinned', pkg: 'a' }] }), /unknown key "pkg" in ignore\[0\]/);
  assert.throws(() => parseConfig({ allowDirect: ['https://user:t0ken@git.example.org/'] }), /leave credentials out of the config/);
  assert.throws(() => parseConfig({ allowDirect: ['https://git.example.org'] }), /end a URL prefix with "\/"/);
  assert.throws(() => parseConfig({ devPatterns: 'requirements-dev.txt' }), /"devPatterns" must be a list/);
  assert.throws(() => parseConfig([]), /expected an object/);
});

test('ignore rules leave findings out of the report and the gate, and the report counts them', async () => {
  const files = { 'requirements.txt': 'example-a>=1\nexample-b>=1\nexample-c==1.0 ; python_version > "3"\n' };
  const r = await check(files, { config: { ignore: [{ check: 'unpinned', package: 'Example_A' }, { check: 'marker-note' }] } });
  assert.deepEqual(find(r, 'unpinned').map((f) => f.package), ['example-b']);
  assert.equal(r.ignored, 2);
  assert.ok(r.notes.includes('2 findings left out by "ignore" rules in the config'));
  const all = await check(files, { config: { ignore: [{ package: 'example-*' }] } });
  assert.deepEqual([all.total, all.gate.pass], [0, true]);
});

test('maskCredentials and safeText: tokens in URLs, control and direction characters, length', () => {
  assert.equal(maskCredentials('https://__token__:pypi-s3cr3t@pypi.example.org/simple'), 'https://***@pypi.example.org/simple');
  assert.equal(maskCredentials('git+https://ghp_t0ken@git.example.org/a.git'), 'git+https://***@git.example.org/a.git');
  assert.equal(maskCredentials('git+ssh://git@git.example.org/a.git'), 'git+ssh://git@git.example.org/a.git');
  assert.equal(maskCredentials('example-a==1.0'), 'example-a==1.0');
  const esc = String.fromCharCode(27);
  assert.equal(safeText(`a${esc}[2Jb${String.fromCharCode(0x202e)}c`), 'a [2Jb c');
  assert.equal(safeText('x'.repeat(400)).length, 300);
  assert.ok(globMatch('example-*', 'EXAMPLE-web'));
  assert.ok(!globMatch('example-?', 'example-ab'));
  assert.ok(isDevFile('requirements-dev.txt') && isDevFile('requirements.in') && isDevFile('test-requirements.txt'));
  assert.ok(!isDevFile('requirements.txt') && !isDevFile('requirements-prod.txt'));
});
