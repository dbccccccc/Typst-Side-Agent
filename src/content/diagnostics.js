/**
 * typst.app "Improve" sidebar diagnostics extraction (MAIN world).
 * Exposes globalThis.__typstAgentImproveExtract.
 *
 * typst.app renders each Improve row roughly like:
 *
 *   [severity dot]  Unexpected argument: leading   (line 10)
 *                   leading: 1.4
 *
 *   [severity dot]  No text with stars   (warning, line 165)   ← Typst section
 *                   +Introduction syntax …
 *
 *   [severity dot]  LaTeX → LaTeX        line 179              ← Misspellings
 *
 * i.e. a main message followed by a badge that is either "(line N)", "line N",
 * or a severity-prefixed variant like "(warning, line N)" / "(error, line N)".
 * The extractor is permissive: it first locates every line badge in the left
 * sidebar, captures the line number AND the declared severity (when present),
 * then recovers the human-readable error text from the badge's surrounding
 * row — stripping the badge itself, leftover severity words, and trailing
 * source snippets.
 */
(function (root) {
  'use strict';

  // Accept badges like:
  //   "line 165"
  //   "(line 165)"
  //   "(warning, line 165)"      ← typst.app "Typst" section
  //   "(error, line 42)"
  //   "warning · line 7"
  //   "error: line 7"
  // Capture group 1 = severity word (optional), group 2 = line number.
  const SEVERITY_WORD = 'error|warning|info|note|hint';
  const LINE_BADGE_RE = new RegExp(
    '^\\s*\\(?\\s*(?:(' + SEVERITY_WORD + ')\\b[\\s,:·•|-]*)?line\\s+(\\d+)\\s*\\)?\\s*$',
    'i'
  );
  const LINE_REF_ANYWHERE_RE = new RegExp(
    '\\(?\\s*(?:(' + SEVERITY_WORD + ')\\b[\\s,:·•|-]*)?line\\s+(\\d+)\\s*\\)?',
    'i'
  );

  function parseBadgeInfo(text) {
    const s = String(text || '');
    const m = s.match(LINE_REF_ANYWHERE_RE);
    if (!m) return null;
    const n = parseInt(m[2], 10);
    if (!Number.isFinite(n)) return null;
    const sev = m[1] ? m[1].toLowerCase() : null;
    return { line: n, severity: sev };
  }

  function parseLineNumber(text) {
    const info = parseBadgeInfo(text);
    return info ? info.line : null;
  }

  function inferSeverity(message) {
    if (!message) return 'error';
    if (/error|unexpected|missing|unknown|unclosed|delimiter|syntax|mismatch|unmatched|overflow|type\s*error|parse\s*error|\binvalid\b|not\s+allowed|not\s+found|failed|cannot\b|could\s+not\b|recursive|duplicate\b|exceeded\b|does\s+not\s+(?:exist|match|converge|stabilize)|did\s+not\s+(?:converge|stabilize)|seems\s+to\s+be\s+infinite|occurs\s+multiple\s+times|is\s+encrypted|out\s+of\s+range|zero[-\s]?sized/i.test(message)) {
      return 'error';
    }
    return 'warning';
  }

  function viewportCutoff(doc) {
    try {
      const w = doc?.defaultView?.innerWidth || 1200;
      return Math.max(320, w * 0.5);
    } catch {
      return 900;
    }
  }

  function inLeftSidebar(el, cutoff) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      return r.left < cutoff && r.right < cutoff + 80;
    } catch {
      return false;
    }
  }

  function ownText(el) {
    let t = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) t += node.nodeValue;
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  function fullText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** Return true if `text` looks like it contains extra content beyond a
   *  "line N" badge (i.e. the ancestor is a plausible diagnostic row, not
   *  just the badge wrapper). */
  function hasRoomForMessage(text, badgeText) {
    if (!text) return false;
    const stripped = text.replace(/\(?\s*line\s+\d+\s*\)?/gi, '').trim();
    return stripped.length >= 4;
  }

  /** Return true if `text` looks like it bundles *multiple* diagnostic
   *  rows (another "line N" reference, or section headers like Comments /
   *  Misspellings / compiler count). When that happens we've climbed past
   *  the individual row and should back off. */
  function looksLikeMultipleRows(text, ownLineNum) {
    if (!text) return false;

    let count = 0;
    const re = /\bline\s+(\d+)\b/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (++count >= 2) return true;
    }

    if (/\bcompiler\s+(error|warning)s?\b/i.test(text)) return true;
    if (/\bNo\s+comments\b/i.test(text)) return true;
    if (/\bAdd\s+the\s+first\s+one\b/i.test(text)) return true;
    if (/\bNo\s+spelling\s+mistakes\b/i.test(text)) return true;
    if (/\bMisspellings\b/.test(text) && /\bComments\b/.test(text)) return true;

    return false;
  }

  /** Walk up from the badge one ancestor at a time and return the SMALLEST
   *  ancestor that contains the badge plus actual message text, without
   *  bleeding into neighbouring rows or sidebar sections. */
  function findRowAncestor(badge, badgeText, lineNum, maxHops) {
    let cur = badge.parentElement;
    let hops = 0;
    while (cur && hops < maxHops) {
      if (cur.tagName === 'ASIDE' || cur.tagName === 'MAIN' || cur.tagName === 'BODY') break;
      const t = fullText(cur);
      if (looksLikeMultipleRows(t, lineNum)) break;
      if (hasRoomForMessage(t, badgeText)) return cur;
      cur = cur.parentElement;
      hops++;
    }
    return null;
  }

  /** Remove the "(line N)" badge text from a row string, strip any .typ
   *  filenames, drop the standalone severity word left behind by the badge
   *  (e.g. "warning,"), collapse whitespace, and trim. */
  function stripBadgeAndNoise(rowText, badgeText) {
    let s = rowText;
    if (badgeText) {
      const esc = badgeText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp('\\s*\\(?' + esc + '\\)?\\s*', 'gi'), ' ');
    }
    // Remove any lingering "(warning|error|..., line N)" / "line N" fragments.
    s = s.replace(
      new RegExp('\\(?\\s*(?:(?:' + SEVERITY_WORD + ')\\b[\\s,:·•|-]*)?line\\s+\\d+\\s*\\)?', 'gi'),
      ' '
    );
    // Remove any orphaned bare "(warning)" / "warning:" badge text that some
    // sidebar layouts render separately from the line badge.
    s = s.replace(new RegExp('\\(\\s*(?:' + SEVERITY_WORD + ')\\s*\\)', 'gi'), ' ');
    s = s.replace(new RegExp('(?:^|\\s)(?:' + SEVERITY_WORD + ')\\s*[,:]\\s+', 'gi'), ' ');
    // Strip file basenames
    s = s.replace(/[\w.-]+\.typ/gi, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }

  /** Known typst error message prefixes. When we spot one, anything that
   *  comes after the matching sentence is treated as a trailing snippet.
   *  Ordered from most-specific to most-generic — `extractFirstSentence`
   *  returns on the first substring match, so specific multi-word prefixes
   *  must appear before their single-word parents. */
  const TYPST_ERROR_PREFIXES = [
    'unexpected argument',
    'unexpected token',
    'unknown variable',
    'unknown function',
    'unknown field',
    'unknown argument',
    'missing argument',
    'missing closing',
    'missing opening',
    'unclosed delimiter',
    'unclosed string',
    'unclosed raw',
    'type error',
    'parse error',
    'syntax error',
    'only one',
    'not enough',
    'too many',
    'the pdf',
    'zero-sized',
    'pagebreaks',
    'automatic',
    'maximum',
    'loop',
    'document',
    'label',
    'selector',
    'package',
    'file',
    'cell',
    'type',
    'expected',
    'cannot',
    'could not',
    'invalid',
    'recursive',
    'duplicate',
    'overflow',
    'failed'
  ];

  /** Extract the first typst error sentence out of `text`. Returns
   *  `{ head, rest }` where `head` is the sentence-ish message and `rest`
   *  is everything after it. If no known prefix is found, `head` is the
   *  whole text. */
  function extractFirstSentence(text) {
    const low = text.toLowerCase();
    for (const prefix of TYPST_ERROR_PREFIXES) {
      const idx = low.indexOf(prefix);
      if (idx === -1) continue;
      // Walk forward until we hit a sentence-ish boundary: period followed
      // by space + uppercase, a known next section header, or end of text.
      const after = text.slice(idx);
      const boundaries = [
        /\.\s+[A-Z]/,
        /\s+comments\b/i,
        /\s+misspellings?\b/i,
        /\s+no\s+spelling\b/i,
        /\s+no\s+comments\b/i,
        /\s+add\s+the\s+first\s+one\b/i
      ];
      let cut = after.length;
      for (const b of boundaries) {
        const m = after.match(b);
        if (m && m.index != null && m.index < cut) cut = m.index;
      }
      return { head: after.slice(0, cut).trim(), rest: after.slice(cut).trim() };
    }
    return { head: text.trim(), rest: '' };
  }

  /** typst.app frequently puts the raw source snippet at the end of the row
   *  (e.g. "Unexpected argument: leading leading: 1.4"). Heuristically split
   *  off that trailing snippet so the message stays clean. */
  function splitMessageFromSnippet(text) {
    if (!text) return { message: '', snippet: '' };
    if (/(?:->|→|⇒)/.test(text)) return { message: text, snippet: '' };

    // Peel off any noise that follows the first recognizable error sentence.
    const { head } = extractFirstSentence(text);
    const clean = head || text;

    // If the sentence still ends in a trailing `name: value` style snippet,
    // split it off.
    const colonTail = clean.match(/^(.+?)(?:\s{2,}|\s)([A-Za-z_][\w.-]*\s*:\s*[^:]+)$/);
    if (colonTail) {
      const headPart = colonTail[1].trim();
      const tailPart = colonTail[2].trim();
      if (headPart.length >= 6 && /[a-z]\s[a-z]/i.test(headPart)) {
        return { message: headPart, snippet: tailPart };
      }
    }

    return { message: clean, snippet: '' };
  }

  function parseBodyToDiagnostic(body, lineNum, badgeSeverity) {
    if (!body) return null;
    const cleaned = body.replace(/\s+/g, ' ').trim();
    if (cleaned.length < 2) return null;

    const arrow = cleaned.match(/^(.+?)\s*(?:->|→|⇒)\s*(.+)$/);
    if (arrow) {
      const original = arrow[1].trim();
      const suggestion = arrow[2].trim();
      return {
        line: lineNum, column: null,
        // Misspellings are purely advisory and live in a separate highlight
        // layer in the editor (typst.app uses a non-lint extension for them).
        // Surface them as 'info' so they are clearly distinct from compiler
        // warnings in every count and display. `kind: 'spelling'` is the
        // authoritative tag consumers should branch on.
        severity: badgeSeverity || 'info',
        kind: 'spelling',
        original, suggestion, message: `${original} → ${suggestion}`
      };
    }

    const { message, snippet } = splitMessageFromSnippet(cleaned);
    const finalMessage = snippet ? `${message} (near \`${snippet}\`)` : message;
    return {
      line: lineNum, column: null,
      // Prefer the severity typst.app shows in the badge (ground truth) over
      // the heuristic keyword match against the message text.
      severity: badgeSeverity || inferSeverity(message || cleaned),
      kind: 'typst', original: null, suggestion: null, message: finalMessage
    };
  }

  /** Find every element whose *own* trimmed text matches a recognized
   *  line badge — either "(line N)" on its own, or prefixed with a severity
   *  word like "(warning, line N)" — that lives in the left sidebar. */
  function findLineBadges(doc, cutoff) {
    const out = [];
    const tags = doc.querySelectorAll('span, div, p, small, button, a, td, strong, em, b, i');
    for (let i = 0; i < tags.length; i++) {
      const el = tags[i];
      const own = ownText(el);
      // Cap own-text at 48 chars so badges like "(warning, line 9999)" fit
      // without letting whole diagnostic sentences slip through.
      if (!own || own.length > 48) continue;
      if (!LINE_BADGE_RE.test(own)) continue;
      if (!inLeftSidebar(el, cutoff)) continue;
      out.push(el);
    }
    // Drop ancestor duplicates — keep the innermost badge node
    return out.filter(el => !out.some(o => o !== el && o.contains(el)));
  }

  function extractDiagnostics(doc) {
    const cutoff = viewportCutoff(doc);
    const badges = findLineBadges(doc, cutoff);
    const seenRows = new WeakSet();
    const out = [];

    for (const badge of badges) {
      const badgeText = ownText(badge);
      const info = parseBadgeInfo(badgeText);
      if (!info) continue;
      const { line: lineNum, severity: badgeSeverity } = info;

      const row = findRowAncestor(badge, badgeText, lineNum, 8);
      if (!row || seenRows.has(row)) continue;
      seenRows.add(row);

      const rowText = fullText(row);
      if (!rowText || rowText.length > 400) continue;
      const body = stripBadgeAndNoise(rowText, badgeText);
      const d = parseBodyToDiagnostic(body, lineNum, badgeSeverity);
      if (d) out.push(d);
    }

    // Dedupe by (line, message)
    const seen = new Set();
    return out.filter(d => {
      const key = `${d.line}|${(d.message || '').slice(0, 200)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  root.__typstAgentImproveExtract = extractDiagnostics;

  /** Diagnostic hook the dev console can call to debug the parser. */
  root.__typstAgentImproveDebug = function () {
    const cutoff = viewportCutoff(document);
    const badges = findLineBadges(document, cutoff);
    const results = extractDiagnostics(document);
    return {
      cutoff,
      badgeCount: badges.length,
      badgeTexts: badges.map(b => ownText(b)),
      badgeInfo: badges.map(b => parseBadgeInfo(ownText(b))),
      rowTexts: badges.map(b => {
        const bt = ownText(b);
        const ln = parseLineNumber(bt) || 0;
        const row = findRowAncestor(b, bt, ln, 8);
        return row ? fullText(row) : null;
      }),
      errorCount: results.filter(d => d.severity === 'error').length,
      warningCount: results.filter(d => d.severity === 'warning').length,
      results
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
