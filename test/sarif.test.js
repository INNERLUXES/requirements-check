import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SARIF_VERSION, SARIF_SCHEMA, sarifUri, toSarif, FINDINGS } from '../src/index.js';
import { check } from './helpers.js';

test('SARIF log: version 2.1.0, one rule per check, results that point at the file, the line and the package', async () => {
  const r = await check({
    'requirements.txt': '\n\nexample-a>=1\n-r more.txt\n',
    'more.txt': 'example-b==1.0 ; sys_platform == "linux"\n--trusted-host pypi.example.internal\n'
  }, { only: ['requirements.txt'] });
  const log = JSON.parse(toSarif(r, '1.2.3'));
  assert.equal(log.version, SARIF_VERSION);
  assert.equal(log.version, '2.1.0');
  assert.equal(log.$schema, SARIF_SCHEMA);
  assert.equal(log.runs.length, 1);
  const driver = log.runs[0].tool.driver;
  assert.equal(driver.name, 'requirements-check');
  assert.equal(driver.version, '1.2.3');
  assert.deepEqual(driver.rules.map((x) => x.id), FINDINGS.map((f) => f.id));
  assert.equal(driver.rules.find((x) => x.id === 'marker-note').defaultConfiguration.level, 'note');
  assert.equal(driver.rules.find((x) => x.id === 'extra-index').defaultConfiguration.level, 'warning');
  assert.equal(driver.rules.find((x) => x.id === 'unpinned').name, 'Unpinned');
  const results = log.runs[0].results;
  assert.deepEqual(results.map((x) => [x.ruleId, x.level]), [['unpinned', 'error'], ['insecure-url', 'warning'], ['marker-note', 'note']]);
  for (const x of results) {
    assert.equal(driver.rules[x.ruleIndex].id, x.ruleId);
    assert.equal(typeof x.message.text, 'string');
    assert.ok(x.partialFingerprints.requirementsCheck.startsWith(x.ruleId));
  }
  assert.deepEqual(results.map((x) => [x.locations[0].physicalLocation.artifactLocation.uri, x.locations[0].physicalLocation.region.startLine]), [
    ['requirements.txt', 3], ['more.txt', 2], ['more.txt', 1]
  ]);
  assert.deepEqual(results[0].locations[0].logicalLocations, [{ name: 'example-a', kind: 'module' }]);
  assert.equal(results[1].locations[0].logicalLocations, undefined, 'an option line names no package');
});

test('SARIF results follow --limit, and an empty report gives an empty result list', async () => {
  const many = Array.from({ length: 5 }, (_, i) => `example-p${i}>=1`).join('\n');
  assert.equal(JSON.parse(toSarif(await check({ 'requirements.txt': many }, { limit: 2 }))).runs[0].results.length, 2);
  assert.deepEqual(JSON.parse(toSarif(await check({ 'requirements.txt': 'example-a==1.0\n' }))).runs[0].results, []);
});

test('sarifUri: relative paths stay relative with forward slashes, absolute paths become file URIs', () => {
  assert.equal(sarifUri('./requirements.txt'), 'requirements.txt');
  assert.equal(sarifUri('services\\api\\requirements.txt'), 'services/api/requirements.txt');
  assert.equal(sarifUri('my app/uv.lock'), 'my%20app/uv.lock');
  assert.equal(sarifUri('C:\\work\\requirements.txt'), 'file:///C:/work/requirements.txt');
  assert.equal(sarifUri('/srv/app/poetry.lock'), 'file:///srv/app/poetry.lock');
  assert.equal(sarifUri(null), 'requirements.txt');
});
