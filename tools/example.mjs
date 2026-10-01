// Runs the README examples and checks that they report what the README shows.

import { main } from '../src/index.js';

async function run(argv) {
  let out = '';
  const code = await main(argv, { out: (t) => { out += t; }, err: (t) => process.stderr.write(t) });
  process.stdout.write(out);
  return { code, out };
}

const problems = [];
function expect(name, result, code, expected, unwanted) {
  const missing = expected.filter((e) => !result.out.includes(e));
  const wrong = unwanted.filter((e) => result.out.includes(e));
  if (result.code !== code || missing.length || wrong.length) {
    problems.push(`${name}: unexpected report (exit code ${result.code}, expected ${code}; missing: ${missing.join(' / ') || 'none'}; should not appear: ${wrong.join(' / ') || 'none'})`);
  }
}

const clean = ['examples/requirements.txt'];
const risky = ['examples/requirements-risky.txt'];

const pass = await run(clean);
expect('requirements.txt', pass, 0, [
  'requirements-check: requirements examples/requirements.txt',
  'files: 1 requirements, 0 constraints, 0 lock',
  'packages: 6 (6 pinned, 6 with hashes, 0 direct references); indexes: default',
  'findings: 0 error, 0 warning, 1 info',
  'example-web-framework  3.0.3    index   2 sha256  examples/requirements.txt:22',
  'INFO      marker-note             examples/requirements.txt:18  example-tz-data is installed only where sys_platform == "win32"',
  'GATE: PASS (--fail-on error)'
], ['ERROR', 'WARNING']);

process.stdout.write('\n');
const locks = await run(['examples/uv.lock', 'examples/poetry.lock']);
expect('uv.lock and poetry.lock', locks, 0, [
  'requirements-check: lock examples/uv.lock, lock examples/poetry.lock',
  'packages: 12 (12 pinned, 12 with hashes, 0 direct references)',
  'example-db-driver      2.9.9    https://pypi.org/simple  2 sha256  examples/uv.lock:5',
  'no findings',
  'GATE: PASS (--fail-on error)'
], ['example-orders-service', 'ERROR', 'WARNING']);

process.stdout.write('\n');
const fail = await run(risky);
expect('requirements-risky.txt', fail, 1, [
  'requirements-check: requirements examples/requirements-risky.txt',
  'files: 2 requirements, 1 constraints, 0 lock',
  'packages: 10 (5 pinned, 1 with hashes, 3 direct references); indexes: http://pypi.example.internal/simple, https://***@pypi.example.org/simple',
  'findings: 9 error, 3 warning, 1 info',
  'ERROR     non-index-source        examples/requirements-risky.txt:11  example-pdf-render comes from a version control repository (git+https://github.com/example-org/example-pdf-render.git@v1.3.0)',
  'ERROR     non-index-source        examples/requirements-risky.txt:12  example-image-tool comes from an archive URL',
  'ERROR     non-index-source        examples/requirements-risky.txt:13  example-legacy-crypto is installed in editable mode from ./vendor/example-legacy-crypto',
  'ERROR     insecure-url            examples/requirements-risky.txt:3  the index http://pypi.example.internal/simple uses an unencrypted connection',
  'ERROR     insecure-url            examples/requirements-risky.txt:12  example-image-tool is fetched over an unencrypted connection',
  'ERROR     unpinned                examples/requirements-risky.txt:10  example-orders-auth has no exact pin (">=1.2")',
  'ERROR     unpinned                examples/requirements-shared.txt:3  example-json-tools has no exact pin (any version)',
  'ERROR     duplicate-requirement   examples/requirements-risky.txt:14  example-cache-client is listed again with "==4.1.0", after "==4.0.2" at examples/requirements-shared.txt:2',
  'ERROR     conflicting-constraint  examples/requirements-risky.txt:16  example-date-utils: the pin ==2.8.2 is outside the constraint "<2.8" (examples/constraints.txt:2)',
  'WARNING   insecure-url            examples/requirements-risky.txt:5  --trusted-host pypi.example.internal',
  'WARNING   extra-index             examples/requirements-risky.txt:4  --extra-index-url https://***@pypi.example.org/simple adds a second index',
  'WARNING   weak-hash               examples/requirements-risky.txt:12  example-image-tool has a hash made with MD5',
  'INFO      marker-note             examples/requirements-risky.txt:15  example-task-queue is installed only where python_version < "3.13"',
  'GATE: FAIL - 9 errors'
], ['s3cr3t', 'deploy:']);

process.stdout.write('\n');
const configured = await run([...risky, '--config', 'examples/requirements-check.json']);
expect('requirements-risky.txt with config', configured, 1, [
  'config examples/requirements-check.json',
  'findings: 9 error, 3 warning, 0 info',
  'ERROR     extra-index             examples/requirements-risky.txt:10  example-orders-auth is a private package',
  'note: 1 finding left out by "ignore" rules in the config',
  'GATE: FAIL - 9 errors'
], ['example-pdf-render comes from', 'INFO      marker-note']);

process.stdout.write('\n');
const stale = await run(['--requirements', 'examples/requirements.txt', '--lock', 'examples/poetry.lock']);
expect('requirements.txt against poetry.lock', stale, 1, [
  'requirements-check: requirements examples/requirements.txt, lock examples/poetry.lock',
  'ERROR     lock-mismatch           examples/requirements.txt:22  example-web-framework is locked at 3.0.2 in examples/poetry.lock, outside "==3.0.3" in examples/requirements.txt',
  'GATE: FAIL - 1 error'
], []);

let sarif = '';
const sarifCode = await main([...risky, '--format', 'sarif'], { out: (t) => { sarif += t; }, err: (t) => process.stderr.write(t) });
const log = JSON.parse(sarif);
const uris = new Set(log.runs[0].results.map((r) => r.locations[0].physicalLocation.artifactLocation.uri));
if (sarifCode !== 1 || log.version !== '2.1.0' || log.runs[0].results.length !== 13 || uris.size !== 2 || !uris.has('examples/requirements-risky.txt') || !uris.has('examples/requirements-shared.txt') || sarif.includes('s3cr3t')) {
  problems.push('sarif: unexpected log');
}

if (problems.length) {
  for (const p of problems) console.error(`example: ${p}`);
  process.exit(1);
}
