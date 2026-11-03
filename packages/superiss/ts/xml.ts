import { fail, type Obj } from './util.ts';

/** Parse bounded JUnit XML without DTDs, entity expansion, or external resources. */
export function junit(xml: string): Obj {
  if (Buffer.byteLength(xml) > 4 * 1024 * 1024) fail('bad_args', 'JUnit exceeds 4 MiB');
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) fail('bad_args', 'XML declarations with entities are forbidden');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(xml)) fail('bad_args', 'invalid XML character');
  type Counts = { tests: number; failures: number; errors: number; skipped: number };
  const empty = (): Counts => ({ tests: 0, failures: 0, errors: 0, skipped: 0 });
  const totals = empty(), stack: string[] = [];
  const suites: Array<{ name: string; declared: Counts; children: Counts }> = [];
  let roots = 0, position = 0, cases = 0, observedFailures = 0, observedErrors = 0, observedSkipped = 0, parsed = false;
  const local = (name: string): string => name.split(':').at(-1) ?? '';
  const finishSuite = (name: string) => {
    const suite = suites.pop();
    if (!suite || suite.name !== name) fail('bad_args', 'mismatched JUnit suite');
    const parent = suites.at(-1)?.children ?? totals;
    for (const key of ['tests', 'failures', 'errors', 'skipped'] as const) {
      parent[key] += Math.max(suite.declared[key], suite.children[key]);
      if (!Number.isSafeInteger(parent[key])) fail('bad_args', 'invalid JUnit count');
    }
  };
  const entities = (s: string) => {
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/iu.test(s)) fail('bad_args', 'invalid XML entity');
    for (const match of s.matchAll(/&#(?:x([0-9a-f]+)|(\d+));/giu)) {
      const n = Number.parseInt(match[1] ?? match[2], match[1] ? 16 : 10);
      if (!(n === 9 || n === 10 || n === 13 || n >= 32 && n <= 0xd7ff || n >= 0xe000 && n <= 0xfffd || n >= 0x10000 && n <= 0x10ffff)) fail('bad_args', 'invalid XML character reference');
    }
  };
  while (position < xml.length) {
    const next = xml.indexOf('<', position), content = xml.slice(position, next < 0 ? undefined : next);
    if (!stack.length && content.trim()) fail('bad_args', 'text outside XML root');
    entities(content);
    if (next < 0) break;
    position = next;
    if (xml.startsWith('<!--', position)) {
      const end = xml.indexOf('-->', position + 4);
      if (end < 0 || xml.slice(position + 4, end).includes('--')) fail('bad_args', 'invalid XML comment');
      position = end + 3; continue;
    }
    if (xml.startsWith('<?', position)) {
      const end = xml.indexOf('?>', position + 2);
      if (end < 0) fail('bad_args', 'invalid XML instruction');
      position = end + 2; continue;
    }
    if (xml.startsWith('<![CDATA[', position)) {
      const end = xml.indexOf(']]>', position + 9);
      if (end < 0 || !stack.length) fail('bad_args', 'invalid XML CDATA');
      position = end + 3; continue;
    }
    let end = position + 1, quote = '';
    for (; end < xml.length; end++) {
      const ch = xml[end];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (end === xml.length || quote) fail('bad_args', 'unterminated XML tag');
    const raw = xml.slice(position + 1, end); position = end + 1;
    const closing = /^\//u.test(raw), selfClosing = /\/\s*$/u.test(raw);
    const match = /^\/?([A-Za-z_:][\w:.-]*)([\s\S]*)$/u.exec(raw);
    if (!match || closing && selfClosing) fail('bad_args', 'invalid XML tag');
    const name = match[1], tail = match[2], kind = local(name);
    if (closing) {
      if (tail.trim() || stack.pop() !== name) fail('bad_args', 'mismatched XML closing tag');
      if (kind === 'testsuite' || kind === 'testsuites') finishSuite(name);
      continue;
    }
    const attributes = new Map<string, string>(), body = selfClosing ? tail.replace(/\/\s*$/u, '') : tail;
    const regex = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/gyu;
    let at = 0;
    while (at < body.length && body.slice(at).trim()) {
      regex.lastIndex = at;
      const attr = regex.exec(body);
      if (!attr || attributes.has(attr[1])) fail('bad_args', 'invalid XML attributes');
      const value = attr[2] ?? attr[3]; entities(value); attributes.set(attr[1], value); at = regex.lastIndex;
    }
    const isRoot = stack.length === 0;
    if (isRoot) {
      if (++roots !== 1 || kind !== 'testsuite' && kind !== 'testsuites') fail('bad_args', 'JUnit must have one testsuite/testsuites root');
    }
    if (kind === 'testsuite' || kind === 'testsuites') {
      const target = empty();
      for (const key of ['tests', 'failures', 'errors', 'skipped'] as const) {
        const value = attributes.get(key);
        if (value === undefined) continue;
        if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) fail('bad_args', 'invalid JUnit count');
        target[key] = Number(value); parsed = true;
      }
      suites.push({ name, declared: target, children: empty() });
    }
    if (kind === 'testcase') { cases++; parsed = true; }
    else if (stack.some(item => local(item) === 'testcase')) {
      if (kind === 'failure') observedFailures++;
      else if (kind === 'error') observedErrors++;
      else if (kind === 'skipped') observedSkipped++;
    }
    if (!selfClosing) stack.push(name);
    else if (kind === 'testsuite' || kind === 'testsuites') finishSuite(name);
    if (stack.length > 256) fail('bad_args', 'XML nesting exceeds 256');
  }
  if (roots !== 1 || stack.length || suites.length) fail('bad_args', 'incomplete XML document');
  const tests = Math.max(totals.tests, cases);
  const failures = Math.max(totals.failures, observedFailures);
  const errors = Math.max(totals.errors, observedErrors);
  const skipped = Math.max(totals.skipped, observedSkipped);
  return { passed: parsed && tests > 0 && failures === 0 && errors === 0, tests, failures, errors, skipped, parsed };
}
