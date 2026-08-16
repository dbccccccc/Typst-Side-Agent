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
   *  whole text. Prefer the earliest prefix in the actual string; otherwise
   *  a later parenthetical such as "(expected comma)" could incorrectly
   *  discard the leading "Failed to parse …" message. */
  function extractFirstSentence(text) {
    const low = text.toLowerCase();
    let first = null;
    for (const prefix of TYPST_ERROR_PREFIXES) {
      const idx = low.indexOf(prefix);
      if (idx === -1) continue;
      if (!first || idx < first.idx || (idx === first.idx && prefix.length > first.prefix.length)) {
        first = { idx, prefix };
      }
    }
    if (!first) return { head: text.trim(), rest: '' };

    // Walk forward until we hit a sentence-ish boundary: period followed
    // by space + uppercase, a known next section header, or end of text.
    const after = text.slice(first.idx);
    const boundaries = [
      /\.\s+[A-Z]/,
      /\s+comments\b/i,
      /\s+misspellings?\b/i,
      /\s+no\s+spelling\b/i,
      /\s+no\s+comments\b/i,
      /\s+add\s+the\s+first\s+one\b/i
    ];
    let cut = after.length;
    for (const boundary of boundaries) {
      const match = after.match(boundary);
      if (match && match.index != null && match.index < cut) cut = match.index;
    }
    return { head: after.slice(0, cut).trim(), rest: after.slice(cut).trim() };
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

  function extractLineDiagnostics(doc, cutoff) {
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

    return out;
  }

  /** Locate the mounted Improve panel by semantics instead of CSS-module
   *  class names. The live app exposes it as a left-side region containing an
   *  accessible heading named "Improve". */
  function findImprovePanel(doc, cutoff) {
    const regions = doc.querySelectorAll('[role="region"]');
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      if (!inLeftSidebar(region, cutoff)) continue;
      const headings = region.querySelectorAll('[role="heading"], h1, h2, h3, h4, strong');
      for (let j = 0; j < headings.length; j++) {
        if (/^Improve$/i.test(ownText(headings[j]))) return region;
      }
    }
    return null;
  }

  /** Parse summaries such as "1 compiler error", "2 compiler warnings",
   *  "1 compiler error, 2 warnings", and "No compiler errors". Null means
   *  that the text is not an authoritative compiler summary. */
  function parseCompilerSummary(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!/\bcompiler\b/i.test(value)) return null;

    let errors = null;
    let warnings = null;
    if (/\bno\s+compiler\s+errors?\b/i.test(value)) errors = 0;
    if (/\bno\s+(?:compiler\s+)?warnings?\b/i.test(value)) warnings = 0;

    const countRe = /(\d+)\s+(?:compiler\s+)?(errors?|warnings?)/gi;
    let match;
    while ((match = countRe.exec(value)) !== null) {
      const count = Math.min(10_000, parseInt(match[1], 10));
      if (!Number.isFinite(count)) continue;
      if (/^error/i.test(match[2])) errors = count;
      else warnings = count;
    }

    if (errors == null && warnings == null) return null;
    return { errors, warnings, text: value };
  }

  function findFollowingList(node, panel) {
    let current = node;
    for (let level = 0; current && current !== panel && level < 5; level++) {
      let sibling = current.nextElementSibling;
      while (sibling) {
        if (sibling.getAttribute?.('role') === 'list') return sibling;
        // Once another compiler summary begins, this group has no visible
        // list. The summary fallback below will preserve the reported count.
        if (parseCompilerSummary(fullText(sibling))) break;
        sibling = sibling.nextElementSibling;
      }
      current = current.parentElement;
    }
    return null;
  }

  function findCompilerGroups(panel) {
    const groups = [];
    const buttons = panel.querySelectorAll('button');
    for (let i = 0; i < buttons.length; i++) {
      const summary = parseCompilerSummary(fullText(buttons[i]));
      if (!summary) continue;
      groups.push({ node: buttons[i], list: findFollowingList(buttons[i], panel), summary });
    }

    // Keep working if typst.app changes the group header from a button to a
    // static label. `ownText` avoids selecting every ancestor of the label.
    if (!groups.length) {
      const labels = panel.querySelectorAll('p, span, div, strong');
      for (let i = 0; i < labels.length; i++) {
        const summary = parseCompilerSummary(ownText(labels[i]));
        if (!summary) continue;
        groups.push({ node: labels[i], list: findFollowingList(labels[i], panel), summary });
      }
    }
    return groups;
  }

  /** typst.app does not render a "0 compiler errors" group when every Improve
   *  category is empty. Instead it replaces all groups with this dedicated,
   *  accessible empty-state message. That message is affirmative evidence of
   *  a clean panel, not an extractor failure. */
  function hasExplicitEmptyState(panel) {
    const paragraphs = panel.querySelectorAll('p');
    for (let i = 0; i < paragraphs.length; i++) {
      const text = fullText(paragraphs[i]);
      if (/\bThere is nothing we can suggest at the moment\b/i.test(text)) return true;
    }
    return false;
  }

  function compilerCardMessage(row) {
    const paragraphs = row.querySelectorAll('p, [role="paragraph"]');
    for (let i = 0; i < paragraphs.length; i++) {
      const text = fullText(paragraphs[i]);
      if (!text || text.length > 2_000 || LINE_BADGE_RE.test(text)) continue;
      return text;
    }
    return fullText(row)
      .replace(/\bLearn how to fix this (?:error|warning)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseCompilerCard(row, groupSummary) {
    const rowText = fullText(row);
    const badge = parseBadgeInfo(rowText);
    const body = stripBadgeAndNoise(compilerCardMessage(row), '');
    if (!body || body.length > 2_000) return null;

    const split = splitMessageFromSnippet(body);
    const message = split.snippet ? `${split.message} (near \`${split.snippet}\`)` : split.message;
    if (!message) return null;

    let severity = badge?.severity || null;
    if (!severity && groupSummary.errors > 0 && !(groupSummary.warnings > 0)) severity = 'error';
    if (!severity && groupSummary.warnings > 0 && !(groupSummary.errors > 0)) severity = 'warning';
    if (!severity) severity = inferSeverity(message);

    return {
      line: badge?.line ?? null,
      column: null,
      severity,
      kind: 'typst',
      original: null,
      suggestion: null,
      message
    };
  }

  function extractCompilerPanel(doc, cutoff) {
    const panel = findImprovePanel(doc, cutoff);
    if (!panel) {
      return {
        panelFound: false,
        explicitEmpty: false,
        summaryFound: false,
        reportedErrors: null,
        reportedWarnings: null,
        diagnostics: []
      };
    }

    if (hasExplicitEmptyState(panel)) {
      return {
        panelFound: true,
        explicitEmpty: true,
        summaryFound: true,
        reportedErrors: 0,
        reportedWarnings: 0,
        diagnostics: []
      };
    }

    const groups = findCompilerGroups(panel);
    const diagnostics = [];
    let reportedErrors = null;
    let reportedWarnings = null;

    for (const group of groups) {
      if (group.summary.errors != null) {
        reportedErrors = (reportedErrors || 0) + group.summary.errors;
      }
      if (group.summary.warnings != null) {
        reportedWarnings = (reportedWarnings || 0) + group.summary.warnings;
      }
      if (!group.list) continue;

      const rows = group.list.querySelectorAll('[role="listitem"]');
      for (let i = 0; i < rows.length; i++) {
        if (!inLeftSidebar(rows[i], cutoff)) continue;
        const diagnostic = parseCompilerCard(rows[i], group.summary);
        if (diagnostic) diagnostics.push(diagnostic);
      }
    }

    return {
      panelFound: true,
      explicitEmpty: false,
      summaryFound: groups.length > 0,
      reportedErrors,
      reportedWarnings,
      diagnostics
    };
  }

  function diagnosticKey(diagnostic) {
    const message = String(diagnostic?.message || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 300);
    return `${diagnostic?.line ?? 'project'}|${diagnostic?.kind || 'typst'}|${message}`;
  }

  function dedupeDiagnostics(diagnostics) {
    const seen = new Set();
    return diagnostics.filter(diagnostic => {
      const key = diagnosticKey(diagnostic);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function summaryPlaceholder(severity, index, missing, reported) {
    const noun = `${severity}${reported === 1 ? '' : 's'}`;
    const detail = missing === 1
      ? `one ${severity}'s details are not visible`
      : `${severity} ${index + 1} of ${missing} has no visible details`;
    return {
      line: null,
      column: null,
      severity,
      kind: 'typst-summary',
      original: null,
      suggestion: null,
      message: `The Improve panel reports ${reported} compiler ${noun}, but ${detail}.`
    };
  }

  function extractDiagnosticsState(doc) {
    const cutoff = viewportCutoff(doc);
    const lineDiagnostics = extractLineDiagnostics(doc, cutoff);
    const compilerPanel = extractCompilerPanel(doc, cutoff);
    const diagnostics = dedupeDiagnostics([...lineDiagnostics, ...compilerPanel.diagnostics]);

    const compilerRows = diagnostics.filter(d => d.kind !== 'spelling' && d.kind !== 'typst-status');
    const parsedErrors = compilerRows.filter(d => d.severity === 'error').length;
    const parsedWarnings = compilerRows.filter(d => d.severity === 'warning').length;

    const addMissing = (severity, reported, parsed) => {
      if (!Number.isInteger(reported) || reported <= parsed) return;
      const missing = Math.min(200 - diagnostics.length, reported - parsed);
      for (let i = 0; i < missing; i++) {
        diagnostics.push(summaryPlaceholder(severity, i, missing, reported));
      }
    };
    addMissing('error', compilerPanel.reportedErrors, parsedErrors);
    addMissing('warning', compilerPanel.reportedWarnings, parsedWarnings);

    // A mounted panel without any recognizable compiler summary is not proof
    // of a clean document. Surface parser uncertainty instead of silently
    // turning a future typst.app markup change into a false CLEAN result.
    if (compilerPanel.panelFound && !compilerPanel.summaryFound && !compilerRows.length) {
      diagnostics.push({
        line: null,
        column: null,
        severity: 'warning',
        kind: 'typst-status',
        original: null,
        suggestion: null,
        message: 'The Improve panel is open, but its compiler status could not be verified. Reopen the panel and read diagnostics again.'
      });
    }

    return { cutoff, lineDiagnostics, compilerPanel, diagnostics: dedupeDiagnostics(diagnostics) };
  }

  function extractDiagnostics(doc) {
    return extractDiagnosticsState(doc).diagnostics;
  }

  root.__typstAgentImproveExtract = extractDiagnostics;

  /** Diagnostic hook the dev console can call to debug the parser. */
  root.__typstAgentImproveDebug = function () {
    const state = extractDiagnosticsState(document);
    const { cutoff } = state;
    const badges = findLineBadges(document, cutoff);
    const results = state.diagnostics;
    return {
      cutoff,
      panelFound: state.compilerPanel.panelFound,
      explicitEmpty: state.compilerPanel.explicitEmpty,
      summaryFound: state.compilerPanel.summaryFound,
      reportedErrors: state.compilerPanel.reportedErrors,
      reportedWarnings: state.compilerPanel.reportedWarnings,
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
