import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml, tableLine } from '../src/index.js';

const refuses = (text, pattern) => assert.throws(() => parseToml(text, 't.toml'), pattern, JSON.stringify(text));

test('TOML: key/value pairs, quoted and dotted keys, strings, numbers and booleans', () => {
  const doc = parseToml([
    '# a comment',
    'title = "orders"  # after a value',
    "path = 'C:\\no\\escapes'",
    'escaped = "tab\\tquote\\" u\\u00e9 U\\U0001F600"',
    'count = 1_000',
    'negative = -3',
    'ratio = 0.5',
    'big = 1e3',
    'on = true',
    'off = false',
    '"quoted key" = 1',
    'a.b.c = "dotted"',
    ''
  ].join('\n'));
  assert.equal(doc.title, 'orders');
  assert.equal(doc.path, 'C:\\no\\escapes');
  assert.equal(doc.escaped, `tab\tquote" u${String.fromCharCode(0xe9)} U${String.fromCodePoint(0x1f600)}`);
  assert.deepEqual([doc.count, doc.negative, doc.ratio, doc.big, doc.on, doc.off], [1000, -3, 0.5, 1000, true, false]);
  assert.equal(doc['quoted key'], 1);
  assert.deepEqual(doc.a, { b: { c: 'dotted' } });
});

test('TOML: tables, arrays of tables and sub-tables of the last element, with the line of each table', () => {
  const doc = parseToml([
    '[metadata]',
    'lock-version = "2.0"',
    '',
    '[[package]]',
    'name = "one"',
    '',
    '[package.dependencies]',
    'x = ">=1"',
    '',
    '[[package]]',
    'name = "two"',
    '[metadata.files]',
    'one = []'
  ].join('\r\n'));
  assert.deepEqual(doc.package.map((p) => p.name), ['one', 'two']);
  assert.deepEqual(doc.package[0].dependencies, { x: '>=1' });
  assert.equal(doc.package[1].dependencies, undefined);
  assert.deepEqual(doc.metadata, { 'lock-version': '2.0', files: { one: [] } });
  assert.deepEqual(doc.package.map(tableLine), [4, 10]);
  assert.equal(tableLine({}), null);
});

test('TOML: arrays over several lines with comments and a trailing comma, inline tables, nesting', () => {
  const doc = parseToml([
    'wheels = [',
    '    { url = "https://files.example.org/a.whl", hash = "sha256:ab", size = 101 },  # first',
    '    # a comment line',
    '    { url = "https://files.example.org/b.whl", hash = "sha256:cd", size = 202 },',
    ']',
    'nested = [[1, 2], ["a"], []]',
    'empty = {}',
    'deep = { a = { b = [true] }, c.d = 1 }'
  ].join('\n'));
  assert.deepEqual(doc.wheels.map((w) => w.size), [101, 202]);
  assert.deepEqual(doc.nested, [[1, 2], ['a'], []]);
  assert.deepEqual(doc.empty, {});
  assert.deepEqual(doc.deep, { a: { b: [true] }, c: { d: 1 } });
});

test('TOML: multi-line basic and literal strings, with the line-ending backslash', () => {
  const doc = parseToml('a = """\nline one\nline two"""\nb = """one \\\n    two"""\nc = \'\'\'raw \\n "here"\'\'\'\nd = """ends with ""quotes"""""\n');
  assert.equal(doc.a, 'line one\nline two');
  assert.equal(doc.b, 'one two');
  assert.equal(doc.c, 'raw \\n "here"');
  assert.equal(doc.d, 'ends with ""quotes""');
});

test('TOML: forms outside the subset are refused with the line, never guessed', () => {
  refuses('a = 1\nwhen = 0000-00-00\n', /t\.toml: line 2: dates and times .* are outside the TOML subset/);
  refuses('at = 07:32:00', /dates and times/);
  refuses('n = 0xff', /outside the TOML subset/);
  refuses('n = inf', /outside the TOML subset/);
  refuses('n = nan', /outside the TOML subset/);
  refuses('n = 01', /not a value this tool reads/);
  refuses('t = { a = 1,\n b = 2 }', /an inline table must be on one line/);
  refuses('t = { a = 1, }', /trailing comma in an inline table/);
  refuses('n = 99999999999999999999', /too large to read exactly/);
});

test('TOML: duplicate keys, tables defined twice and broken syntax are refused', () => {
  refuses('a = 1\na = 2', /line 2: the key "a" is defined twice/);
  refuses('[x]\n[x]', /line 2: the table \[x\] is defined twice/);
  refuses('x = 1\n[[x]]', /not an array of tables/);
  refuses('x = [1]\n[[x]]', /not an array of tables/);
  refuses('t = { a = 1 }\n[t]', /defined twice/);
  refuses('t = { a = 1 }\nt.b = 2', /already a value, not a table/);
  refuses('a = "open', /not closed on its line/);
  refuses('a = """open', /multi-line string is not closed/);
  refuses('a = "\\x"', /escape \\x is not valid/);
  refuses('a = "\\uD800"', /not a Unicode scalar value/);
  refuses('a = 1 b = 2', /unexpected text after a value/);
  refuses('a =', /a key without a value/);
  refuses('= 1', /expected a key/);
  refuses('[a', /not closed/);
  refuses('a = [1, 2', /an array is not closed|expected , or \]/);
});

test('TOML: "__proto__" is an ordinary key, and deep nesting is refused', () => {
  const doc = parseToml('__proto__ = { polluted = true }\n[constructor]\nx = 1');
  assert.deepEqual(Object.keys(doc), ['__proto__', 'constructor']);
  assert.equal(doc.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
  refuses(`a = ${'['.repeat(80)}${']'.repeat(80)}`, /nested more than 64 deep/);
});
