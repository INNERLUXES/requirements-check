// A small reader for the part of TOML that uv.lock and poetry.lock use:
//   key = value pairs with bare, quoted and dotted keys; [tables] and [[arrays of tables]];
//   basic and literal strings, single-line and multi-line; decimal integers and floats; true and false;
//   arrays (over several lines, with comments and a trailing comma); inline tables on one line.
// Anything else (dates and times, hexadecimal, octal or binary numbers, inf and nan) is refused with the line
// where it appears, rather than read in a way that might be wrong. Duplicate keys and tables are refused too.

const MAX_DEPTH = 64;

// The line on which each table of the document starts (tables from [headers] and [[headers]]).
const TABLE_LINES = new WeakMap();
const DEFINED = new WeakSet(); // tables named by a [header]
const ARRAY_OF_TABLES = new WeakSet(); // arrays built by [[headers]]
const FIXED = new WeakSet(); // inline tables and static arrays, which cannot be extended later

export function tableLine(table) {
  return TABLE_LINES.get(table) ?? null;
}

const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Sets a key without going through a prototype setter, so a key named "__proto__" is plain data.
function put(table, key, value) {
  Object.defineProperty(table, key, { value, enumerable: true, writable: true, configurable: true });
}

class Reader {
  constructor(text, label) {
    this.s = text;
    this.i = 0;
    this.line = 1;
    this.label = label;
  }

  fail(message, line = this.line) {
    throw new Error(`${this.label}: line ${line}: ${message}`);
  }

  peek(n = 0) {
    return this.s[this.i + n];
  }

  next() {
    const c = this.s[this.i];
    this.i += 1;
    if (c === '\n') this.line += 1;
    return c;
  }

  // Spaces and tabs only.
  blank() {
    while (this.peek() === ' ' || this.peek() === '\t') this.i += 1;
  }

  comment() {
    if (this.peek() !== '#') return;
    while (this.i < this.s.length && this.peek() !== '\n') {
      const c = this.next();
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(c)) this.fail('a control character in a comment');
    }
  }

  // The end of a line: optional spaces and a comment, then a newline or the end of the text.
  endOfLine() {
    this.blank();
    this.comment();
    if (this.peek() === '\r' && this.peek(1) === '\n') this.i += 1;
    if (this.i >= this.s.length) return;
    if (this.peek() !== '\n') this.fail(`unexpected text after a value: ${JSON.stringify(this.s.slice(this.i, this.i + 20))}`);
    this.next();
  }

  // Spaces, newlines and comments, as allowed inside an array.
  space() {
    for (;;) {
      this.blank();
      if (this.peek() === '#') this.comment();
      else if (this.peek() === '\n') this.next();
      else if (this.peek() === '\r' && this.peek(1) === '\n') this.i += 1;
      else return;
    }
  }

  key() {
    const parts = [];
    for (;;) {
      this.blank();
      const c = this.peek();
      if (c === '"') parts.push(this.basicString());
      else if (c === "'") parts.push(this.literalString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i, this.i + 512));
        if (!m) this.fail(`expected a key, found ${JSON.stringify(this.s.slice(this.i, this.i + 20))}`);
        parts.push(m[0]);
        this.i += m[0].length;
      }
      this.blank();
      if (this.peek() !== '.') return parts;
      this.i += 1;
    }
  }

  escape() {
    const c = this.next();
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (Object.hasOwn(simple, c)) return simple[c];
    if (c === 'u' || c === 'U') {
      const len = c === 'u' ? 4 : 8;
      const hex = this.s.slice(this.i, this.i + len);
      if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) this.fail(`a bad \\${c} escape`);
      this.i += len;
      const code = parseInt(hex, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail(`\\${c}${hex} is not a Unicode scalar value`);
      return String.fromCodePoint(code);
    }
    return this.fail(`the escape \\${c ?? ''} is not valid in a TOML string`);
  }

  basicString() {
    if (this.s.startsWith('"""', this.i)) return this.multiline('"');
    this.i += 1;
    let out = '';
    for (;;) {
      if (this.i >= this.s.length || this.peek() === '\n') this.fail('a string is not closed on its line');
      const c = this.next();
      if (c === '"') return out;
      if (c === '\\') out += this.escape();
      else if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(c)) this.fail('a control character in a string');
      else out += c;
    }
  }

  literalString() {
    if (this.s.startsWith("'''", this.i)) return this.multiline("'");
    this.i += 1;
    const end = this.s.indexOf("'", this.i);
    const nl = this.s.indexOf('\n', this.i);
    if (end === -1 || (nl !== -1 && nl < end)) this.fail('a string is not closed on its line');
    const out = this.s.slice(this.i, end);
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(out)) this.fail('a control character in a string');
    this.i = end + 1;
    return out;
  }

  multiline(q) {
    const start = this.line;
    this.i += 3;
    if (this.peek() === '\n') this.next();
    else if (this.peek() === '\r' && this.peek(1) === '\n') { this.i += 1; this.next(); }
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) this.fail('a multi-line string is not closed', start);
      if (this.s.startsWith(q.repeat(3), this.i)) {
        // Up to two quotes may sit right before the closing three.
        let extra = 0;
        while (extra < 2 && this.peek(3 + extra) === q) extra += 1;
        out += q.repeat(extra);
        this.i += 3 + extra;
        return out;
      }
      const c = this.next();
      if (q === '"' && c === '\\') {
        // A backslash at the end of a line trims the newline and the white space that follows.
        let j = this.i;
        while (this.s[j] === ' ' || this.s[j] === '\t') j += 1;
        if (this.s[j] === '\n' || (this.s[j] === '\r' && this.s[j + 1] === '\n')) {
          this.i = j;
          while (/[ \t\r\n]/.test(this.peek() ?? '')) this.next();
        } else out += this.escape();
      } else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(c)) this.fail('a control character in a string');
      else out += c;
    }
  }

  bare() {
    const m = /^[^\s,\]}#]+/.exec(this.s.slice(this.i, this.i + 256));
    if (!m) this.fail(`expected a value, found ${JSON.stringify(this.s.slice(this.i, this.i + 20))}`);
    const t = m[0];
    this.i += t.length;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^[+-]?(?:0|[1-9](?:_?\d)*)$/.test(t)) {
      const n = Number(t.replace(/_/g, ''));
      if (!Number.isSafeInteger(n)) this.fail(`the integer ${t} is too large to read exactly`);
      return n;
    }
    if (/^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/.test(t)) return Number(t.replace(/_/g, ''));
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(t)) this.fail(`dates and times (${t}) are outside the TOML subset this tool reads`);
    if (/^[+-]?(?:0[xob]|inf$|nan$)/.test(t)) this.fail(`${t} is outside the TOML subset this tool reads (decimal numbers only)`);
    return this.fail(`${JSON.stringify(t)} is not a value this tool reads (strings, numbers, true, false, arrays and inline tables)`);
  }

  value(depth) {
    if (depth > MAX_DEPTH) this.fail(`values nested more than ${MAX_DEPTH} deep`);
    const c = this.peek();
    if (c === '"') return this.basicString();
    if (c === "'") return this.literalString();
    if (c === '[') return this.array(depth);
    if (c === '{') return this.inlineTable(depth);
    if (c === undefined || c === '\n' || c === '\r' || c === '#') return this.fail('a key without a value');
    return this.bare();
  }

  array(depth) {
    this.i += 1;
    const out = [];
    for (;;) {
      this.space();
      if (this.peek() === ']') {
        this.i += 1;
        FIXED.add(out);
        return out;
      }
      if (this.i >= this.s.length) this.fail('an array is not closed');
      out.push(this.value(depth + 1));
      this.space();
      if (this.peek() === ',') this.i += 1;
      else if (this.peek() !== ']') this.fail('expected , or ] in an array');
    }
  }

  inlineTable(depth) {
    this.i += 1;
    const out = {};
    FIXED.add(out);
    this.blank();
    if (this.peek() === '}') {
      this.i += 1;
      return out;
    }
    for (;;) {
      this.blank();
      if (this.peek() === '\n' || this.peek() === '\r') this.fail('an inline table must be on one line');
      const keys = this.key();
      if (this.peek() !== '=') this.fail('expected = after a key');
      this.i += 1;
      this.blank();
      this.assign(out, keys, this.value(depth + 1), true);
      this.blank();
      if (this.peek() === ',') {
        this.i += 1;
        this.blank();
        if (this.peek() === '}') this.fail('a trailing comma in an inline table');
      } else if (this.peek() === '}') {
        this.i += 1;
        return out;
      } else this.fail('expected , or } in an inline table');
    }
  }

  // Sets a dotted key in a table, creating the tables between.
  assign(table, keys, value, inline = false) {
    let t = table;
    for (const k of keys.slice(0, -1)) {
      if (!Object.hasOwn(t, k)) {
        const sub = {};
        put(t, k, sub);
        t = sub;
      } else if (isTable(t[k]) && (inline || !FIXED.has(t[k]))) t = t[k];
      else this.fail(`the key ${JSON.stringify(k)} is already a value, not a table`);
    }
    const last = keys[keys.length - 1];
    if (Object.hasOwn(t, last)) this.fail(`the key ${JSON.stringify(keys.join('.'))} is defined twice`);
    put(t, last, value);
  }

  header(root) {
    const line = this.line;
    const many = this.s.startsWith('[[', this.i);
    this.i += many ? 2 : 1;
    const keys = this.key();
    if (many ? !this.s.startsWith(']]', this.i) : this.peek() !== ']') this.fail(`a table header is not closed with ${many ? ']]' : ']'}`);
    this.i += many ? 2 : 1;
    let t = root;
    for (const k of keys.slice(0, -1)) {
      if (!Object.hasOwn(t, k)) {
        const sub = {};
        put(t, k, sub);
        t = sub;
      } else if (Array.isArray(t[k]) && ARRAY_OF_TABLES.has(t[k])) t = t[k][t[k].length - 1];
      else if (isTable(t[k]) && !FIXED.has(t[k])) t = t[k];
      else this.fail(`the key ${JSON.stringify(k)} is already a value, not a table`);
    }
    const last = keys[keys.length - 1];
    let table;
    if (many) {
      if (!Object.hasOwn(t, last)) {
        const list = [];
        ARRAY_OF_TABLES.add(list);
        put(t, last, list);
      } else if (!(Array.isArray(t[last]) && ARRAY_OF_TABLES.has(t[last]))) this.fail(`[[${keys.join('.')}]] names something that is not an array of tables`);
      table = {};
      t[last].push(table);
    } else {
      if (!Object.hasOwn(t, last)) {
        table = {};
        put(t, last, table);
      } else if (isTable(t[last]) && !FIXED.has(t[last]) && !DEFINED.has(t[last])) table = t[last];
      else this.fail(`the table [${keys.join('.')}] is defined twice`);
    }
    DEFINED.add(table);
    TABLE_LINES.set(table, line);
    this.endOfLine();
    return table;
  }

  document() {
    const root = {};
    let current = root;
    for (;;) {
      this.space();
      if (this.i >= this.s.length) return root;
      if (this.peek() === '[') {
        current = this.header(root);
        continue;
      }
      const keys = this.key();
      if (this.peek() !== '=') this.fail('expected = after a key');
      this.i += 1;
      this.blank();
      this.assign(current, keys, this.value(0));
      this.endOfLine();
    }
  }
}

// Reads TOML text in the subset above into plain objects and arrays. Throws an error that names the line.
export function parseToml(text, label = 'TOML file') {
  const source = String(text).replace(/^\uFEFF/, '');
  return new Reader(source, label).document();
}
