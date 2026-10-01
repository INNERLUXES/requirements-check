import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseArgs, main, toText, toMarkdown, toJson, toCsv, csvCell, mdCell, USAGE, VERSION, LIMITS } from '../src/index.js';
import { check, withFiles, H } from './helpers.js';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const at = (p) => join(root, p).split('\\').join('/');
const quiet = { out: () => {}, err: () => {} };

async function capture(argv, limits) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (t) => { out += t; }, err: (t) => { err += t; } }, limits);
  return { code, out, err };
}

const clean = [at('examples/requirements.txt')];
const risky = [at('examples/requirements-risky.txt')];

// A report with text that tries to break each format.
function hostile() {
  return check({ 'requirements.txt': 'example-a==1.0 ; python_version > "3" and extra == "=cmd|x"\n' });
}

test('parseArgs reads options and refuses bad input', () => {
  const o = parseArgs(['a.txt', 'b.lock', '--requirements', 'r.txt', '--lock', 'uv.lock', '--config', 'c.json', '--format', 'sarif', '--fail-on', 'warning', '--want-hashes', '--dev-pattern', 'ci-*.txt', '--dev-pattern', '*.dev', '--limit', '50']);
  assert.deepEqual([o.files, o.requirements, o.lock, o.config, o.format, o.failOn, o.wantHashes, o.devPatterns, o.limit], [['a.txt', 'b.lock'], 'r.txt', 'uv.lock', 'c.json', 'sarif', 'warning', true, ['ci-*.txt', '*.dev'], 50]);
  const d = parseArgs(['requirements.txt']);
  assert.deepEqual([d.format, d.failOn, d.limit, d.wantHashes, d.lock, d.config], ['text', 'error', 200, false, null, null]);
  assert.throws(() => parseArgs([]), /give at least one file/);
  assert.throws(() => parseArgs(['r.txt', '--format', 'xml']), /unknown format xml/);
  assert.throws(() => parseArgs(['r.txt', '--format', 'toString']), /unknown format/);
  assert.throws(() => parseArgs(['r.txt', '--fail-on', 'info']), /error or warning/);
  assert.throws(() => parseArgs(['r.txt', '--limit', '0']), /--limit takes a whole number/);
  assert.throws(() => parseArgs(['https://example.com/requirements.txt']), /never fetches a URL/);
  assert.throws(() => parseArgs(['--lock']), /needs a value/);
  assert.throws(() => parseArgs(['r.txt', '--fix']), /unknown argument --fix/);
  assert.throws(() => parseArgs(['r.txt', '--dev-pattern', 'dir/x.txt']), /without folders/);
  assert.throws(() => parseArgs(['-']), /standard input/);
});

test('exit codes: 0 clean, 1 on errors or with --fail-on warning, 2 on usage or input errors', async () => {
  assert.equal(await main(clean, quiet), 0);
  assert.equal(await main([...clean, '--fail-on', 'warning'], quiet), 0);
  assert.equal(await main(risky, quiet), 1);
  assert.equal(await main(['--nope'], quiet), 2);
  assert.equal(await main(['--help'], quiet), 0);
  const v = await capture(['--version']);
  assert.equal(v.out.trim(), VERSION);
  const missing = await capture([at('examples/none.txt')]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no such file/);
  const notLock = await capture(['--lock', at('examples/requirements-check.json')]);
  assert.equal(notLock.code, 2);
  assert.match(notLock.err, /not a value this tool reads|expected a key/);
  const badConfig = await capture([...clean, '--config', at('package.json')]);
  assert.equal(badConfig.code, 2);
  assert.match(badConfig.err, /config: unknown key "name"/);
  const usage = await capture(['--format', 'json']);
  assert.equal(usage.code, 2);
  assert.ok(usage.err.includes(USAGE));
});

test('a warning-only file passes by default and fails with --fail-on warning; --want-hashes adds warnings', async () => {
  await withFiles({ 'requirements-dev.txt': 'example-lint>=6\n', 'requirements.txt': 'example-a==1.0\n' }, async (dir) => {
    const dev = [join(dir, 'requirements-dev.txt')];
    assert.equal(await main(dev, quiet), 0);
    assert.equal(await main([...dev, '--fail-on', 'warning'], quiet), 1);
    const plain = [join(dir, 'requirements.txt')];
    assert.equal(await main([...plain, '--fail-on', 'warning'], quiet), 0);
    assert.equal(await main([...plain, '--fail-on', 'warning', '--want-hashes'], quiet), 1);
    assert.equal(await main([...plain, '--dev-pattern', 'requirements.txt'], quiet), 0);
  });
});

test('size limits: a file over the byte limit or with too many lines stops the run with exit code 2', async () => {
  const text = Array.from({ length: 20 }, (_, i) => `example-p${i}==1.0`).join('\n');
  await withFiles({ 'requirements.txt': text, 'uv.lock': text.replace(/example-(p\d+)==1\.0/g, '[[package]]\nname = "example-$1"\nversion = "1.0"\n') }, async (dir) => {
    const req = [join(dir, 'requirements.txt')];
    const big = await capture(req, { ...LIMITS, maxFileBytes: 100 });
    assert.equal(big.code, 2);
    assert.match(big.err, /over the .* MB limit/);
    const many = await capture(req, { ...LIMITS, maxRequirements: 10 });
    assert.equal(many.code, 2);
    assert.match(many.err, /more than 10 requirement lines/);
    const lock = await capture([join(dir, 'uv.lock')], { ...LIMITS, maxRequirements: 10 });
    assert.equal(lock.code, 2);
    assert.match(lock.err, /20 locked packages is over the limit of 10/);
    assert.equal((await capture(req)).code, 0);
  });
});

test('the clean example: summary, package table, one marker note and a passing gate', async () => {
  const { code, out } = await capture(clean);
  assert.equal(code, 0);
  assert.ok(out.startsWith(`requirements-check: requirements ${at('examples/requirements.txt')}\nfiles: 1 requirements, 0 constraints, 0 lock\n`));
  assert.ok(out.includes('packages: 6 (6 pinned, 6 with hashes, 0 direct references); indexes: default\n'));
  assert.ok(out.includes('findings: 0 error, 0 warning, 1 info\n'));
  assert.ok(out.includes('INFO      marker-note             '));
  assert.ok(out.endsWith('GATE: PASS (--fail-on error)\n'));
  const locks = await capture([at('examples/uv.lock'), at('examples/poetry.lock')]);
  assert.equal(locks.code, 0);
  assert.ok(locks.out.includes('files: 0 requirements, 0 constraints, 2 lock\npackages: 12 (12 pinned, 12 with hashes, 0 direct references)'));
});

test('the risky example: every check it holds, errors first, credentials masked', async () => {
  const { code, out } = await capture(risky);
  assert.equal(code, 1);
  assert.ok(out.includes('files: 2 requirements, 1 constraints, 0 lock\n'));
  assert.ok(out.includes('findings: 9 error, 3 warning, 1 info\n'));
  const order = [...out.matchAll(/^(ERROR|WARNING|INFO) +([a-z-]+)/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(order, [
    'ERROR non-index-source', 'ERROR non-index-source', 'ERROR non-index-source', 'ERROR insecure-url', 'ERROR insecure-url',
    'ERROR unpinned', 'ERROR unpinned', 'ERROR duplicate-requirement', 'ERROR conflicting-constraint',
    'WARNING insecure-url', 'WARNING extra-index', 'WARNING weak-hash', 'INFO marker-note'
  ]);
  assert.ok(out.includes('https://***@pypi.example.org/simple'));
  assert.ok(!out.includes('s3cr3t'));
  assert.ok(out.endsWith('GATE: FAIL - 9 errors\n'));
});

test('the config example marks private packages, allows one git host and ignores one note', async () => {
  const { code, out } = await capture([...risky, '--config', at('examples/requirements-check.json')]);
  assert.equal(code, 1);
  assert.ok(out.includes('findings: 9 error, 3 warning, 0 info\n'));
  assert.ok(/^ERROR +extra-index .*example-orders-auth is a private package/m.test(out));
  assert.ok(!out.includes('example-pdf-render comes from'));
  assert.ok(out.includes('note: 1 finding left out by "ignore" rules in the config'));
});

test('--requirements with --lock: the stale Poetry lock file is reported; uv.lock matches', async () => {
  const stale = await capture(['--requirements', at('examples/requirements.txt'), '--lock', at('examples/poetry.lock')]);
  assert.equal(stale.code, 1);
  assert.ok(/ERROR +lock-mismatch .*example-web-framework is locked at 3\.0\.2 in .*poetry\.lock, outside "==3\.0\.3"/.test(stale.out));
  const fresh = await capture(['--requirements', at('examples/requirements.txt'), '--lock', at('examples/uv.lock')]);
  assert.equal(fresh.code, 0);
  const half = await capture(['--lock', at('examples/uv.lock')]);
  assert.ok(half.out.includes('note: lock-mismatch needs both --requirements and --lock; only --lock was given'));
});

test('--limit shows the first findings and packages, and the total', async () => {
  const { out } = await capture([...risky, '--limit', '2']);
  assert.ok(out.includes('findings: 9 error, 3 warning, 1 info (showing 2 of 13)\n'));
  assert.equal((out.match(/^ERROR /gm) || []).length, 2);
  assert.ok(out.includes('note: showing the first 2 findings of 13; raise --limit to see more'));
  assert.ok(out.includes('note: showing the first 2 of 10 packages'));
});

test('JSON: the whole report, findings with package, version, file and line', async () => {
  const r = JSON.parse((await capture([...risky, '--format', 'json'])).out);
  assert.equal(r.tool, 'requirements-check');
  assert.equal(r.total, 13);
  assert.deepEqual(r.counts, { error: 9, warning: 3, info: 1 });
  assert.equal(r.byCheck['non-index-source'], 3);
  const f = r.findings.find((x) => x.id === 'conflicting-constraint');
  assert.deepEqual([f.package, f.version, f.file.endsWith('examples/requirements-risky.txt'), f.line], ['example-date-utils', '2.8.2', true, 16]);
  assert.equal(r.packages.length, 10);
  assert.deepEqual(r.files.map((x) => x.kind), ['requirements', 'requirements', 'constraints']);
  const h = await hostile();
  assert.equal(toJson(h), JSON.stringify(h, null, 2) + '\n');
});

test('Markdown escapes pipes, backslashes and line breaks in every cell', async () => {
  assert.equal(mdCell('a|b\\c\nd'), 'a\\|b\\\\c d');
  const md = toMarkdown(await hostile());
  assert.ok(md.startsWith('## requirements-check: 0 error, 0 warning, 1 info\n'));
  assert.ok(md.includes('| info | marker-note | requirements.txt:1 | example-a is installed only where python_version > "3" and extra == "=cmd\\|x" |'));
  for (const line of md.split('\n').filter((l) => l.startsWith('| info'))) assert.equal(line.split(/(?<!\\)\|/).length, 6);
});

test('CSV quotes as RFC 4180 says and defuses formulas', async () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(csvCell('@x'), "'@x");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell(null), '');
  const formula = await check({ '=cmd.txt': 'example-a>=1\n-r https://files.example.org/x.txt\n' });
  const lines = toCsv(formula).split('\r\n');
  assert.equal(lines[0], 'type,severity,id,package,version,file,line,message');
  assert.ok(lines[1].startsWith("finding,error,non-index-source,,,'=cmd.txt,2,\"'-r https://files.example.org/x.txt includes"));
  assert.ok(lines.includes("package,,,example-a,>=1,'=cmd.txt,1,index; hashes: -"));
  assert.ok(toCsv(formula).endsWith('\r\n'));
});

test('text: control characters from the input cannot reach the terminal', async () => {
  const esc = String.fromCharCode(27);
  const r = await check({ 'requirements.txt': `example-a==1.0 ; os_name == "x${esc}]0;title${esc}[2J"\n` });
  const text = toText(r);
  assert.ok(!text.includes(esc));
  assert.ok(text.includes('os_name == "x ]0;title [2J"'));
});

test('credentials in index URLs, direct references and lock files are masked in every format', async () => {
  const files = {
    'requirements.txt': [
      '--index-url https://__token__:pypi-s3cr3tT0ken@pypi.example.internal/simple',
      '--extra-index-url http://ci-user:pa55@extra.example.internal/simple',
      'example-a @ git+https://ghtok3n@git.example.org/a.git@v1',
      `example-b==1.0 --hash=${H('b')}`
    ].join('\n'),
    'uv.lock': '[[package]]\nname = "example-c"\nversion = "1.0"\nsource = { registry = "https://deploy:l0ckT0ken@pypi.example.internal/simple" }\n'
  };
  await withFiles(files, async (dir) => {
    for (const format of ['text', 'markdown', 'json', 'csv', 'sarif']) {
      const { out } = await capture([join(dir, 'requirements.txt'), join(dir, 'uv.lock'), '--format', format]);
      for (const secret of ['pypi-s3cr3tT0ken', '__token__', 'ci-user', 'pa55', 'ghtok3n', 'l0ckT0ken', 'deploy:']) assert.ok(!out.includes(secret), `${format} shows ${secret}`);
      assert.ok(out.includes('git+https://***@git.example.org/a.git@v1'), format);
      if (format !== 'sarif') assert.ok(out.includes('https://***@pypi.example.internal/simple'), format);
    }
  });
});
