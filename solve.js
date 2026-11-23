// Swiftfold — a fast drop-in for makefun-site 1.0.0.
//
// The same answers as makefun-site 1.0.0, built for CPU time: one pass over each
// body instead of a lex-then-render token walk, a single-scan HTML escape instead
// of one regex call per character, templates flattened once with their includes
// inlined (depth-capped exactly like the reference), and no per-page object
// churn beyond what the templates can observe. Dependency-free, stdlib only.
//
// The reference's rules live in its README; where this file and that README
// differ, the reference code is the answer, so every branch below follows the
// reference code's behaviour, including its edge cases.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped, in one scan. Returns `text` itself when nothing needs escaping. */
const ESCAPE_RE = /[&<>"']/g;
function escapeHtml(text) {
  ESCAPE_RE.lastIndex = 0;
  let m = ESCAPE_RE.exec(text);
  if (m === null) return text;
  let out = '';
  let i = 0;
  do {
    if (m.index > i) out += text.slice(i, m.index);
    out += ESCAPES[m[0]];
    i = m.index + 1;
    m = ESCAPE_RE.exec(text);
  } while (m !== null);
  if (i < text.length) out += text.slice(i);
  return out;
}

/** Slug memo, reset for every case so one case never feeds the next. */
let slugCache = new Map();

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-" left at the cut dropped), "untitled" when nothing is left. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const s = slugifySlow(text);
  slugCache.set(text, s);
  return s;
}

function slugifySlow(text) {
  // Pure ASCII is fixed under NFKD and holds no combining marks, so the
  // normalise-and-strip step can be skipped for it.
  let plain = text;
  if (!/^[\x00-\x7F]*$/.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = '';
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === '') {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out[end - 1] === '-') end--;
  out = out.slice(0, end);
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

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Non-ASCII whitespace, the only kind an ASCII-only check would miss. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

/** The words of `lines` (from `start`): its runs of characters other than whitespace. A "\n" join between lines never merges or splits a word, so the lines can be counted as they stand. */
function wordsOfLines(lines, start) {
  let count = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    let inWord = false;
    for (let j = 0; j < line.length; j++) {
      if (WS_TABLE[line.charCodeAt(j)] === 1) inWord = false;
      else if (!inWord) {
        inWord = true;
        count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function rstripSpacesTabs(s) {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return s.slice(0, end);
}

function isKeyChars(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || c === 95)) return false;
  }
  return true;
}

function isNameChars(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugChars(s) {
  // a-z and 0-9, single "-" between runs: [a-z0-9]+(-[a-z0-9]+)*
  if (s.length === 0) return false;
  let i = 0;
  while (i < s.length) {
    if (!isAlnumLower(s.charCodeAt(i))) return false;
    while (i < s.length && isAlnumLower(s.charCodeAt(i))) i++;
    if (i === s.length) return true;
    if (s.charCodeAt(i) !== 45) return false;
    i++;
    if (i === s.length) return false;
  }
  return true;
}

function isAlnumLower(c) {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
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
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isNameChars(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugChars(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter: { data, bodyStart } (the index of the first body line in `lines`),
 * or { error } with the first reason it is refused. `lines` is the source split on "\n".
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line[0] === '#') continue;
    const ci = line.indexOf(':');
    if (ci < 1 || !isKeyChars(line.slice(0, ci))) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, ci);
    const rest = line.slice(ci + 1);
    let raw;
    if (rest === '') raw = '';
    else if (rest[0] === ' ') raw = rest.slice(1);
    else return { error: `line ${i + 1} is not "key: value"` };
    raw = rstripSpacesTabs(raw);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return line.slice(a, b);
}

/** The first index from `from` (below `to`) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, to) {
  for (let j = from; j <= to - what.length; j++) {
    if (s[j] === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (below `to`; one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` from `lo` to `hi`, HTML-escaped, appended to `out`. */
function pushEscaped(out, s, lo, hi) {
  ESCAPE_RE.lastIndex = lo;
  let m = ESCAPE_RE.exec(s);
  let i = lo;
  while (m !== null && m.index < hi) {
    if (m.index > i) out.push(s.slice(i, m.index));
    out.push(ESCAPES[m[0]]);
    i = m.index + 1;
    m = ESCAPE_RE.exec(s);
  }
  if (hi > i) out.push(s.slice(i, hi));
}

/** The next inline-significant character, found with one regex scan (lastIndex is reset on every call, so the shared regex is safe across the recursion below). */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/**
 * `s` from `lo` to `hi` rendered inline into `out`. `link` resolves a link target to its href.
 * Plain runs are copied untouched (they hold no escapable character by construction), so the
 * only escaping work is on code spans, link hrefs and the rare escaped character. Nested
 * spans render into the same output, over ranges of the same string, with no slicing.
 */
function inlineInto(s, link, out, lo, hi) {
  let i = lo;
  while (i < hi) {
    // The next character that needs handling, found with one regex scan:
    // prose is mostly plain text, and nine separate scans would re-read it.
    SPECIAL_RE.lastIndex = i;
    const found = SPECIAL_RE.exec(s);
    const j = found === null || found.index >= hi ? hi : found.index;
    if (j > i) out.push(s.slice(i, j));
    if (j >= hi) break;
    i = j;
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      out.push(ESCAPES[s[i]]);
      i++;
    } else if (c === 92) {
      if (i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
        out.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
    } else if (c === 96) {
      const m = s.indexOf('`', i + 1);
      if (m !== -1 && m < hi && m > i + 1) {
        out.push('<code>');
        pushEscaped(out, s, i + 1, m);
        out.push('</code>');
        i = m + 1;
      } else {
        out.push('`');
        i++;
      }
    } else if (c === 42) {
      if (s[i + 1] === '*') {
        const m = findUnescaped(s, '**', i + 2, hi);
        if (m > i + 2) {
          out.push('<strong>');
          inlineInto(s, link, out, i + 2, m);
          out.push('</strong>');
          i = m + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const m = findSingleStar(s, i + 1, hi);
        if (m > i + 1) {
          out.push('<em>');
          inlineInto(s, link, out, i + 1, m);
          out.push('</em>');
          i = m + 1;
        } else {
          out.push('*');
          i++;
        }
      }
    } else {
      // '['
      const m = findUnescaped(s, ']', i + 1, hi);
      const close = m !== -1 && s[m + 1] === '(' ? s.indexOf(')', m + 2) : -1;
      const hasClose = close !== -1 && close < hi;
      const target = hasClose ? s.slice(m + 2, close) : '';
      if (target !== '' && !/\s/.test(target)) {
        const href = link(target);
        out.push('<a href="');
        pushEscaped(out, href, 0, href.length);
        out.push('">');
        inlineInto(s, link, out, i + 1, m);
        out.push('</a>');
        i = close + 1;
      } else {
        out.push('[');
        i++;
      }
    }
  }
}

/** `s` rendered inline; `link` resolves a link target to its href. */
function inline(s, link) {
  const out = [];
  inlineInto(s, link, out, 0, s.length);
  return out.length === 1 ? out[0] : out.join('');
}

/** The language of a fence-opening line, "" for a bare fence, or null when the line opens no fence. */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    j++;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line[h] === '#') h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let a = h;
  while (a < line.length) {
    const cc = line.charCodeAt(a);
    if (cc !== 32 && cc !== 9) break;
    a++;
  }
  let b = line.length;
  while (b > a) {
    const cc = line.charCodeAt(b - 1);
    if (cc !== 32 && cc !== 9) break;
    b--;
  }
  if (b === a) return null;
  return { depth: h, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  if (!(line.startsWith('---') || line.startsWith('***'))) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * `lines` (from `start`) rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading: level, id and its inline HTML)
 * and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(lines, start, link) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let code = `<pre><code${cls}>`;
      for (const l of body) {
        code += escapeHtml(l);
        code += '\n';
      }
      code += '</code></pre>';
      blocks.push(code);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        const l = lines[i++];
        body.push(l[1] === ' ' ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = (line[0] === '-' || line[0] === '*') && line[1] === ' ';
    let ordered = null;
    if (!bullet) {
      let d = 0;
      while (d < line.length && d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (d >= 1 && d <= 9 && line[d] === '.' && line[d + 1] === ' ') ordered = { digits: d, start: Number(line.slice(0, d)) };
    }
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          let d = 0;
          while (d < l.length && d < 9 && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          if (d >= 1 && d <= 9 && l[d] === '.' && l[d + 1] === ' ') {
            items.push([trimLine(l.slice(d + 2))]);
            i++;
            continue;
          }
        } else if ((l[0] === '-' || l[0] === '*') && l[1] === ' ') {
          items.push([trimLine(l.slice(2))]);
          i++;
          continue;
        }
        if (/^ {2,}\S/.test(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      let list = `${open}\n`;
      for (const parts of items) list += `<li>${inline(parts.join('\n'), link)}</li>\n`;
      list += `</${tag}>`;
      blocks.push(list);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Compiled ops. A template renders in the same scope it is included from, so
// includes can be flattened into the includer's op list once, capped at the
// same depth the reference stops at. Each `for` op keeps one reusable frame
// (its loop variable and `loop` object), mutated per iteration instead of
// rebuilt: a compiled op is active at most once at a time, because includes
// are flattened and every inclusion site compiles its own copy.
//
// A path's first name is resolved at compile time, too: the frames a render
// walks are the root frame and then one frame per enclosing `for`, in nesting
// order, so the frame that binds a name is fixed by where the op sits — the
// nearest enclosing `for` that binds it (or `loop`, bound by the innermost
// `for`), else the root. The op keeps that frame's index (`fi`), its first
// name and the rest of the path; rendering then reads the frame directly
// instead of walking a scope chain with a property check per step.
const OP_TEXT = 0;
const OP_VAR = 1;
const OP_RAW = 2;
const OP_IF = 3;
const OP_FOR = 4;

/** The frame index binding `first` among `forStack` (outermost first), or 0 for the root, or -1 for none. */
function frameIndexOf(forStack, first) {
  if (first === 'loop') return forStack.length === 0 ? -1 : forStack.length;
  for (let k = forStack.length - 1; k >= 0; k--) {
    if (forStack[k] === first) return k + 1;
  }
  return 0;
}

/** `nodes` compiled to a flat op list, includes inlined. `depth` is the include depth of this list; `forStack` the enclosing `for` variables, outermost first. */
function compileNodes(nodes, templates, depth, forStack) {
  const ops = [];
  for (const n of nodes) {
    if (n.kind === 'text') ops.push({ t: OP_TEXT, s: n.text });
    else if (n.kind === 'var') ops.push({ t: OP_VAR, first: n.path[0], rest: n.path.slice(1), fi: frameIndexOf(forStack, n.path[0]) });
    else if (n.kind === 'raw') ops.push({ t: OP_RAW, first: n.path[0], rest: n.path.slice(1), fi: frameIndexOf(forStack, n.path[0]) });
    else if (n.kind === 'if') {
      ops.push({
        t: OP_IF,
        first: n.path[0],
        rest: n.path.slice(1),
        fi: frameIndexOf(forStack, n.path[0]),
        not: n.not,
        then: compileNodes(n.then, templates, depth, forStack),
        els: n.else === null ? null : compileNodes(n.else, templates, depth, forStack),
      });
    } else if (n.kind === 'for') {
      const loop = { index: 0, first: false, last: false, length: 0 };
      const vars = { loop };
      ops.push({
        t: OP_FOR,
        name: n.name,
        first: n.path[0],
        rest: n.path.slice(1),
        fi: frameIndexOf(forStack, n.path[0]),
        body: compileNodes(n.body, templates, depth, [...forStack, n.name]),
        vars,
        loop,
        frame: { vars },
      });
    } else if (n.kind === 'include') {
      const target = templates.get(n.name);
      if (target !== undefined && depth < INCLUDE_DEPTH) ops.push(...compileNodes(target, templates, depth + 1, forStack));
    }
  }
  return ops;
}

/** The value at an op's path in `frames` (the root frame, then one frame per enclosing `for`, in nesting order). */
function lookupAt(frames, op) {
  const f = op.fi;
  if (f < 0) return undefined;
  const frame = frames[f];
  if (frame === undefined) return undefined;
  let v;
  if (f === 0) {
    if (!Object.hasOwn(frame.vars, op.first)) return undefined;
    v = frame.vars[op.first];
  } else {
    v = frame.vars[op.first];
  }
  const rest = op.rest;
  for (let k = 0; k < rest.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, rest[k])) return undefined;
    v = v[rest[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += textOf(v[k]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `ops` rendered with `frames` (the root frame, then one frame per enclosing `for`), appended to `out`. */
function renderOps(ops, frames, out) {
  for (const op of ops) {
    if (op.t === OP_TEXT) {
      out.push(op.s);
    } else if (op.t === OP_VAR) {
      out.push(escapeHtml(textOf(lookupAt(frames, op))));
    } else if (op.t === OP_RAW) {
      out.push(textOf(lookupAt(frames, op)));
    } else if (op.t === OP_IF) {
      const branch = truthy(lookupAt(frames, op)) !== op.not ? op.then : op.els;
      if (branch !== null) renderOps(branch, frames, out);
    } else {
      const xs = lookupAt(frames, op);
      if (!Array.isArray(xs)) continue;
      const frame = op.frame;
      const loop = op.loop;
      const vars = op.vars;
      const len = xs.length;
      frames.push(frame);
      for (let k = 0; k < len; k++) {
        vars[op.name] = xs[k];
        loop.index = k + 1;
        loop.first = k === 0;
        loop.last = k === len - 1;
        loop.length = len;
        renderOps(op.body, frames, out);
      }
      frames.pop();
    }
  }
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A link's href resolver for one source: `dir` its directory, `sourcePath` its path (for the report). */
function makeLink(dir, bySource, staticPaths, base, broken, sourcePath) {
  return (target) => {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') return target;
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(dir, rel);
    if (path !== null) {
      const pg = bySource.get(path);
      if (pg !== undefined) return `${pg.url}${frag}`;
      if (staticPaths.has(path)) return `${base}/${path}${frag}`;
    }
    broken.add(`broken-link ${sourcePath} -> ${target}`);
    return target;
  };
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const broken = new Set();

  // Templates, parsed in code-unit order of their name. One that does not
  // parse is reported and left out, as if it were not there.
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Compiled on first use, includes flattened (depth-capped like the reference).
  const compiled = new Map();
  const opsOf = (name) => {
    let ops = compiled.get(name);
    if (ops === undefined) {
      const nodes = templates.get(name);
      if (nodes === undefined) return null;
      ops = compileNodes(nodes, templates, 0, []);
      compiled.set(name, ops);
    }
    return ops;
  };

  // Sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, then the refusal checks in their order: the generator's own
  // directories, a post with no date, an unparsable layout, a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    let own = null;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== null) {
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

  // Permalinks: each slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const md = renderMarkdown(s.lines, s.bodyStart, makeLink(dirOf(s.path), bySource, staticPaths, base, broken, s.path));
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOfLines(s.lines, s.bodyStart);
  }

  // Collections: the posts, newest date first, and equal dates by slug. Each
  // post's `newer` is the one before it in that order and its `older` the one after.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by their slug, each named as first met walking the posts in
  // collection order, ordered by count of posts, most first, then by slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const ops = opsOf(name);
    if (ops === null) return null;
    const out = [];
    renderOps(ops, [{ vars: { site, tags: allTags, recent, ...vars } }], out);
    return out.join('');
  };
  for (const s of kept) {
    const page = {
      ...cardOf(s),
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
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
