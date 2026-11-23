// A fast drop-in for makefun-site 1.0.0: run(input) returns the same output tree its build returns, byte for byte,
// computed with leaner machinery — a range-based inline renderer that never slices the text it scans, a slug rule
// with an ASCII fast path and a per-case memo, a front-matter reader that walks lines by index instead of splitting
// the whole file, and a template engine whose nodes are flat arrays rendered into a shared output buffer.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text primitives

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped, and nothing else. */
function escapeHtml(text) {
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;

/** The slug of `text`, computed directly (no memo): NFKD, marks dropped, lowered, runs of other characters one "-". */
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a code unit is JavaScript whitespace (the \s set), for word counting and link-target checks. */
const WS_HI = new Set([160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]);
function isSpaceCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || (c >= 160 && WS_HI.has(c));
}

/** The number of words in `text`: its runs of characters other than whitespace. */
function countWords(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      count++;
      inWord = true;
    }
  }
  return count;
}

/** Whether `text` holds any whitespace character (a link target must hold none). */
function hasSpace(text) {
  for (let i = 0; i < text.length; i++) if (isSpaceCode(text.charCodeAt(i))) return true;
  return false;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has
 * "\n" line ends. Lines are walked by index; the body is one slice, never a split-and-join of the whole file.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // Find the closing line first (the reference scans for it before it reads any line between).
  const fmLines = [];
  let bodyStart = -1;
  let pos = firstNl + 1;
  let idx = 1; // the 0-based index of the line at `pos`
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') {
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(idx, line);
    if (nl === -1) break;
    pos = nl + 1;
    idx++;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k += 2) {
    const lineIdx = fmLines[k];
    const line = fmLines[k + 1];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${lineIdx + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- templates
//
// Nodes are flat arrays: ['t', text] a text run, ['v', path] an escaped substitution, ['r', path] a raw one,
// ['f', name, path, body] a for, ['i', not, path, then, else] an if (else may be null), ['n', name] an include.
// A path is its names in an array, split once at parse time.

class TemplateError extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

/** The path `text` names, split at its dots, or a TemplateError. */
function tplPath(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text runs, substitutions and {% %} tags, a standalone tag's line taken with it. */
function tplTokens(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      text += src.slice(i, open);
      if (text !== '') tokens.push('t', text);
      text = '';
      tokens.push(raw ? 'r' : 'v', tplPath(name, src.slice(open + (raw ? 3 : 2), close).trim()));
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    let standalone = true;
    for (let k = lineStart; k < open && standalone; k++) if (src[k] !== ' ' && src[k] !== '\t') standalone = false;
    for (let k = end; k < lineEnd && standalone; k++) if (src[k] !== ' ' && src[k] !== '\t') standalone = false;
    text += src.slice(i, open);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push('t', text);
    text = '';
    tokens.push('g', src.slice(open + 2, close).trim());
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push('t', text);
  return tokens;
}

/** `src` parsed into its node tree (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ arr: root, node: null }];
  const toks = tplTokens(name, src);
  for (let k = 0; k < toks.length; k += 2) {
    const kind = toks[k];
    const val = toks[k + 1];
    const top = stack[stack.length - 1];
    if (kind === 't') {
      top.arr.push(['t', val]);
      continue;
    }
    if (kind === 'v' || kind === 'r') {
      top.arr.push([kind, val]);
      continue;
    }
    const tag = val;
    let m;
    if ((m = TPL_FOR.exec(tag)) !== null) {
      const node = ['f', m[1], tplPath(name, m[2]), []];
      top.arr.push(node);
      stack.push({ arr: node[3], node });
    } else if ((m = TPL_IF.exec(tag)) !== null) {
      const node = ['i', m[1] !== undefined, tplPath(name, m[2]), [], null];
      top.arr.push(node);
      stack.push({ arr: node[3], node });
    } else if (tag === 'else') {
      if (top.node === null || top.node[0] !== 'i' || top.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.node[4] = [];
      top.arr = top.node[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'f' : 'i';
      if (top.node === null || top.node[0] !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
    } else if ((m = TPL_INCLUDE.exec(tag)) !== null) {
      top.arr.push(['n', m[1]]);
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].node[0] === 'f' ? 'for' : 'if'} is not closed`);
  return root;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function tplLookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function tplText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tplText).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` (an array of strings) in `scope`; `templates` maps names to parsed node trees. */
function tplRender(nodes, scope, templates, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const node = nodes[idx];
    switch (node[0]) {
      case 't':
        out.push(node[1]);
        break;
      case 'v':
        out.push(escapeHtml(tplText(tplLookup(scope, node[1]))));
        break;
      case 'r':
        out.push(tplText(tplLookup(scope, node[1])));
        break;
      case 'i': {
        const branch = tplTruthy(tplLookup(scope, node[2])) !== node[1] ? node[3] : node[4];
        if (branch !== null) tplRender(branch, scope, templates, depth, out);
        break;
      }
      case 'f': {
        const xs = tplLookup(scope, node[2]);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [node[1]]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          tplRender(node[3], { vars, parent: scope }, templates, depth, out);
        }
        break;
      }
      case 'n': {
        const t = templates.get(node[1]);
        if (t !== undefined && depth < INCLUDE_DEPTH) tplRender(t, scope, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- Markdown

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;

/** A line with its spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return MD_BLANK.test(line) || MD_FENCE_OPEN.test(line) || headingOf(line) !== null || MD_HR.test(line);
}

/** The characters a backslash escapes, as a table indexed by code unit. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;
function isEscapable(code) {
  return code < 128 && ESCAPABLE[code] === 1;
}

/** The first index in [from, end) where `s` holds `what` (']' or '**') outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const w = what.charCodeAt(0);
  const last = end - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) === w && (what.length === 1 || s.charCodeAt(j + 1) === w)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * The range [i0, end) of `s` rendered inline into `out`; `link(target)` is a link's href. Plain runs between special
 * characters are escaped in one call each, and nested strong/emphasis/link text recurses on ranges, never on slices.
 */
function inlineRange(s, i0, end, link, out) {
  let i = i0;
  let runStart = i0;
  while (i < end) {
    const c = s[i];
    if (c === '\\' && i + 1 < end && isEscapable(s.charCodeAt(i + 1))) {
      if (i > runStart) out.push(escapeHtml(s.slice(runStart, i)));
      const n = s[i + 1];
      out.push(n === '>' ? '&gt;' : n);
      i += 2;
      runStart = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        if (i > runStart) out.push(escapeHtml(s.slice(runStart, i)));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        runStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < end && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, end);
        if (j > i + 2) {
          if (i > runStart) out.push(escapeHtml(s.slice(runStart, i)));
          out.push('<strong>');
          inlineRange(s, i + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
          runStart = i;
          continue;
        }
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j > i + 1) {
        if (i > runStart) out.push(escapeHtml(s.slice(runStart, i)));
        out.push('<em>');
        inlineRange(s, i + 1, j, link, out);
        out.push('</em>');
        i = j + 1;
        runStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, end);
      let m = -1;
      if (k !== -1 && k + 1 < end && s[k + 1] === '(') {
        const idx = s.indexOf(')', k + 2);
        if (idx !== -1 && idx < end) m = idx;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasSpace(target)) {
        if (i > runStart) out.push(escapeHtml(s.slice(runStart, i)));
        out.push('<a href="', escapeHtml(link(target)), '">');
        inlineRange(s, i + 1, k, link, out);
        out.push('</a>');
        i = m + 1;
        runStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (end > runStart) out.push(escapeHtml(s.slice(runStart, end)));
}

/** `s` rendered inline, whole. */
function inlineText(s, link) {
  const out = [];
  inlineRange(s, 0, s.length, link, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (a "\n" after every block), its table of contents (every level 2 and 3 heading) and its
 * excerpt (the first paragraph's inline HTML, or ""). Blocks are lexed and rendered in one pass over the lines.
 */
function renderMarkdown(src, link, slugify) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const toc = [];
  let html = '';
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (MD_BLANK.test(line)) {
      i++;
      continue;
    }
    const fence = MD_FENCE_OPEN.exec(line);
    if (fence !== null) {
      let body = '';
      i++;
      while (i < n && !MD_FENCE_CLOSE.test(lines[i])) {
        body += `${escapeHtml(lines[i])}\n`;
        i++;
      }
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
      html += `<pre><code${cls}>${body}</code></pre>\n`;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const inner = inlineText(heading.text, link);
      html += `<h${heading.depth} id="${id}">${inner}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: inner });
      i++;
      continue;
    }
    if (MD_HR.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i];
        const stripped = raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1);
        const t = trimLine(stripped);
        if (t !== '') kept.push(t);
        i++;
      }
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineText(kept.join('\n'), link)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = MD_BULLET.exec(line);
    const ordered = bullet === null ? MD_ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? MD_ORDERED : MD_BULLET;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (MD_CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? Number(ordered[1]) : 1;
      let block = `${isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`}\n`;
      for (const parts of items) block += `<li>${inlineText(parts.join('\n'), link)}</li>\n`;
      html += `${block}</${tag}>\n`;
      continue;
    }
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    const inner = inlineText(parts.join('\n'), link);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text, exactly as makefun-site 1.0.0's build returns it. */
export function run(input) {
  // Slugs are recomputed often (titles, tags, headings); memoise them for this case only.
  const slugCache = new Map();
  const slugify = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugifyRaw(text);
      slugCache.set(text, v);
    }
    return v;
  };

  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources in code-unit order of path, line ends made "\n"; any other file is static.
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // Front matter and the refusal checks, in their order; a refused or draft source is reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest date first, and equal dates by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // The tags: grouped by slug, each named as first met walking the posts in collection order.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const tagBySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = tagBySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        tagBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return tagBySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...tagBySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages and layouts.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    tplRender(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of sources) {
    // A post's card was already built for the cards map; a page's is built here. The values are the same either way.
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = sources.reduce((acc, s) => acc + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
