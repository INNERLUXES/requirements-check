// Report formats: text for a terminal, Markdown for a pull request or job summary, JSON for other tools,
// CSV for a spreadsheet. SARIF for code scanning is in sarif.js.

function inputs(r) {
  const s = r.sources || {};
  const parts = [];
  for (const f of s.requirements || []) parts.push(`requirements ${f}`);
  for (const f of s.locks || []) parts.push(`lock ${f}`);
  if (s.config) parts.push(`config ${s.config}`);
  return parts.length ? parts.join(', ') : 'no files';
}

function n(value) {
  return value.toLocaleString('en-US');
}

function plural(count, one, many = `${one}s`) {
  return `${n(count)} ${count === 1 ? one : many}`;
}

function filesLine(r) {
  const s = r.summary;
  return `files: ${n(s.requirementFiles)} requirements, ${n(s.constraintFiles)} constraints, ${n(s.lockFiles)} lock`;
}

function packagesLine(r) {
  const s = r.summary;
  const indexes = s.indexes.length ? s.indexes.join(', ') : 'default';
  return `packages: ${n(s.packages)} (${n(s.pinned)} pinned, ${n(s.hashed)} with hashes, ${plural(s.direct, 'direct reference')}); indexes: ${indexes}`;
}

function findingSummary(r) {
  const shown = r.findings.length < r.total ? ` (showing ${n(r.findings.length)} of ${n(r.total)})` : '';
  return `${r.counts.error} error, ${r.counts.warning} warning, ${r.counts.info} info${shown}`;
}

function hashCell(p) {
  return p.hashes ? `${p.hashes} ${p.algorithms.join('+')}` : '-';
}

function packageRows(r) {
  return {
    head: ['Package', 'Version', 'Source', 'Hashes', 'File'],
    rows: r.packages.map((p) => [p.name ?? '-', p.version ?? '-', p.source, hashCell(p), `${p.file}:${p.line}`])
  };
}

function where(f) {
  return f.file ? `${f.file}:${f.line}` : '-';
}

function textTable({ head, rows }) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? String(c) : String(c).padEnd(widths[i]))).join('  ').trimEnd();
  return [line(head), ...rows.map(line)];
}

export function toText(r) {
  const lines = [
    `requirements-check: ${inputs(r)}`,
    filesLine(r),
    packagesLine(r),
    `findings: ${findingSummary(r)}`
  ];
  if (r.packages.length) lines.push('', ...textTable(packageRows(r)));
  if (!r.findings.length) lines.push('', 'no findings');
  for (const f of r.findings) lines.push('', `${f.severity.toUpperCase().padEnd(8)}  ${f.id.padEnd(22)}  ${where(f)}  ${f.message}`);
  if (r.notes.length) lines.push('');
  for (const note of r.notes) lines.push(`note: ${note}`);
  lines.push('', r.gate.pass ? `GATE: PASS (--fail-on ${r.gate.failOn})` : `GATE: FAIL - ${r.gate.reason}`);
  return lines.join('\n') + '\n';
}

// A Markdown table cell: backslashes and pipes escaped, line breaks flattened, so text from an input file cannot break the table.
export function mdCell(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n|\r/g, ' ');
}

function mdTable({ head, rows }) {
  return [
    `| ${head.map(mdCell).join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`)
  ];
}

export function toMarkdown(r) {
  const lines = [
    `## requirements-check: ${findingSummary(r)}`,
    '',
    `${mdCell(inputs(r))}.`,
    '',
    `${mdCell(filesLine(r))}; ${mdCell(packagesLine(r))}.`
  ];
  if (r.packages.length) lines.push('', ...mdTable(packageRows(r)));
  if (!r.findings.length) lines.push('', 'No findings.');
  else {
    lines.push('', '| Severity | Check | Location | Message |', '| --- | --- | --- | --- |');
    for (const f of r.findings) lines.push(`| ${f.severity} | ${mdCell(f.id)} | ${mdCell(where(f))} | ${mdCell(f.message)} |`);
  }
  if (r.notes.length) lines.push('');
  for (const note of r.notes) lines.push(`- ${mdCell(note)}`);
  lines.push('', r.gate.pass ? `**Gate passed** (--fail-on ${r.gate.failOn}).` : `**Gate failed:** ${mdCell(r.gate.reason)}.`);
  return lines.join('\n') + '\n';
}

export function toJson(r) {
  return JSON.stringify(r, null, 2) + '\n';
}

// RFC 4180 quoting, and a leading quote on cells a spreadsheet would read as a formula.
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One row per finding, then one per package.
export function toCsv(r) {
  const rows = [['type', 'severity', 'id', 'package', 'version', 'file', 'line', 'message']];
  for (const f of r.findings) rows.push(['finding', f.severity, f.id, f.package, f.version, f.file, f.line, f.message]);
  for (const p of r.packages) rows.push(['package', '', '', p.name, p.version, p.file, p.line, `${p.source}; hashes: ${hashCell(p)}`]);
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
