import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, isValidName, parseVersion, formatVersion, compareVersions, parseSpecifiers, exactPin, specifierText, satisfies } from '../src/index.js';

const yes = (v, s) => assert.equal(satisfies(v, s).match, true, `${v} should satisfy "${s}"`);
const no = (v, s) => assert.equal(satisfies(v, s).match, false, `${v} should not satisfy "${s}"`);

test('normalizeName follows PEP 503: lower case, runs of - _ . become one -', () => {
  assert.equal(normalizeName('Example_Web.Framework'), 'example-web-framework');
  assert.equal(normalizeName('a--b__c..d'), 'a-b-c-d');
  assert.equal(normalizeName('A-_.b'), 'a-b');
  assert.equal(normalizeName('example-web-framework'), 'example-web-framework');
});

test('isValidName follows PEP 508: letters and digits at both ends, . - _ inside', () => {
  for (const good of ['a', 'A1', 'a.b-c_d', 'example-orders-models']) assert.ok(isValidName(good), good);
  for (const bad of ['', '-a', 'a-', 'a b', 'a@b', '.a', null, 'x'.repeat(201)]) assert.ok(!isValidName(bad), String(bad));
});

test('parseVersion reads PEP 440 versions with epoch, prerelease, post, dev and local parts', () => {
  assert.deepEqual(parseVersion('1.4.2'), { epoch: 0, release: [1, 4, 2], pre: null, post: null, dev: null, local: null });
  assert.deepEqual(parseVersion('2!1.0rc1.post2.dev3+ubuntu.1'), { epoch: 2, release: [1, 0], pre: ['rc', 1], post: 2, dev: 3, local: ['ubuntu', '1'] });
  assert.deepEqual(parseVersion('1.0-alpha.1').pre, ['a', 1]);
  assert.deepEqual(parseVersion('1.0c2').pre, ['rc', 2]);
  assert.equal(parseVersion('1.0-1').post, 1);
  assert.equal(parseVersion('1.0.post').post, 0);
  assert.equal(parseVersion('v3.0').release[0], 3);
  assert.equal(formatVersion(parseVersion('1.0-ALPHA.1_post.2-dev')), '1.0a1.post2.dev0');
  for (const bad of ['latest', '1.0.x', '1..0', '', null, '9'.repeat(200), '1.0+']) assert.equal(parseVersion(bad), null, String(bad));
});

test('compareVersions orders dev releases, prereleases, finals, local and post releases as PEP 440 says', () => {
  const order = ['1.0.dev0', '1.0a1', '1.0a2.dev1', '1.0a2', '1.0b1', '1.0rc1', '1.0', '1.0+local', '1.0.post1.dev0', '1.0.post1', '1.1', '1!0.1'];
  for (let i = 0; i < order.length - 1; i += 1) {
    assert.equal(compareVersions(parseVersion(order[i]), parseVersion(order[i + 1])), -1, `${order[i]} < ${order[i + 1]}`);
  }
  assert.equal(compareVersions(parseVersion('1.0'), parseVersion('1.0.0')), 0);
  assert.equal(compareVersions(parseVersion('1.0+a'), parseVersion('1.0'), { local: false }), 0);
});

test('parseSpecifiers reads clauses with or without parentheses and refuses forms that are not PEP 440', () => {
  assert.deepEqual(parseSpecifiers('>=1.0, <2').specs.map((s) => s.op), ['>=', '<']);
  assert.deepEqual(parseSpecifiers('(==1.4.*)').specs, [{ op: '==', version: '1.4', wildcard: true }]);
  assert.deepEqual(parseSpecifiers('').specs, []);
  assert.equal(parseSpecifiers('===anything-goes').specs[0].version, 'anything-goes');
  for (const bad of ['~=1', '>=1.*', '=>1.0', 'abc', '==1.0+local.*', '>=1.0;']) assert.equal(parseSpecifiers(bad).ok, false, bad);
  assert.equal(parseSpecifiers(Array(70).fill('>=1').join(',')).ok, false);
});

test('exactPin is the version of an == clause without a wildcard, or of an === clause', () => {
  const pin = (s) => exactPin(parseSpecifiers(s).specs);
  assert.equal(pin('==1.2.3'), '1.2.3');
  assert.equal(pin('>=1,==1.5'), '1.5');
  assert.equal(pin('===1.0-custom'), '1.0-custom');
  assert.equal(pin('==1.*'), null);
  assert.equal(pin('>=1.0'), null);
  assert.equal(pin(''), null);
  assert.equal(specifierText(parseSpecifiers('<2.0, >=1.0').specs), specifierText(parseSpecifiers('>=1, <2').specs));
});

test('satisfies: ==, != and wildcards, ~=, ordered comparisons and ===', () => {
  yes('1.4.2', '==1.4.*');
  no('1.5', '==1.4.*');
  yes('1.0', '==1.0.0');
  yes('1.0+local', '==1.0');
  no('1.0', '==1.0+local');
  no('1.5', '!=1.5');
  yes('1.4.2', '~=1.4');
  no('2.0', '~=1.4');
  yes('1.4.5', '~=1.4.2');
  no('1.5.0', '~=1.4.2');
  no('1.4.1', '~=1.4.2');
  yes('1.0', '>=1.0, <2');
  no('2.0', '>=1.0, <2');
  yes('foo', '===foo');
  no('1.0.0', '===1.0');
});

test('satisfies: > leaves out post releases and < leaves out prereleases of the named version', () => {
  no('1.7.post1', '>1.7');
  yes('1.8', '>1.7');
  yes('1.7.post2', '>1.7.post1');
  no('1.7rc1', '<1.7');
  yes('1.6', '<1.7');
  yes('1.7rc1', '<1.7rc2');
  const bad = satisfies('not a version', '==1.0');
  assert.deepEqual([bad.ok, bad.match], [false, null]);
});
