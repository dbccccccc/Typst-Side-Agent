/**
 * The sole untrusted Markdown-to-DOM boundary. Marked parses with raw HTML
 * escaped, DOMPurify returns a strict DOM fragment, unsafe links become text,
 * and inline images are never created.
 */
const MARKDOWN_TAGS = Object.freeze([
  'p', 'br', 'strong', 'em', 'del', 'a', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td'
]);
const FORBIDDEN_TAGS = ['form', 'input', 'button', 'iframe', 'frame', 'object', 'embed', 'img', 'video', 'audio', 'source', 'style', 'script'];

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = s => escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function isAllowedMarkdownUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch { return false; }
}

function plainTextFragment(text) {
  const fragment = document.createDocumentFragment();
  fragment.appendChild(document.createTextNode(String(text || '')));
  return fragment;
}

export function renderMarkdownFragment(text) {
  try {
    if (!window.marked?.parse || !window.DOMPurify?.sanitize) throw new Error('Renderer libraries unavailable');
    const dirty = window.marked.parse(String(text || ''));
    const fragment = window.DOMPurify.sanitize(dirty, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: MARKDOWN_TAGS,
      ALLOWED_ATTR: ['href', 'title'],
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: FORBIDDEN_TAGS,
      FORBID_ATTR: ['style', 'src', 'srcset']
    });
    fragment.querySelectorAll('a').forEach(link => {
      const href = link.getAttribute('href');
      if (!isAllowedMarkdownUrl(href)) {
        link.replaceWith(document.createTextNode(link.textContent || ''));
        return;
      }
      link.setAttribute('rel', 'noopener noreferrer');
      link.setAttribute('target', '_blank');
    });
    return fragment;
  } catch (error) {
    console.warn('Typst Side Agent Markdown render failed:', error?.message || String(error));
    return plainTextFragment(text);
  }
}

export function renderMarkdownInto(element, text) {
  element.replaceChildren(renderMarkdownFragment(text));
}

export function setupMarkdown() {
  try {
    const renderer = new window.marked.Renderer();
    renderer.html = html => escapeHtml(typeof html === 'string' ? html : html?.text || '');
    renderer.link = (href, title, label) => {
      const text = escapeHtml(label || href || 'link');
      if (!isAllowedMarkdownUrl(href)) return text;
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<a href="${escapeAttr(href)}"${titleAttr}>${text}</a>`;
    };
    renderer.image = (href, title, alt) => {
      const label = `Image: ${escapeHtml(alt || 'attachment')}`;
      if (!isAllowedMarkdownUrl(href)) return label;
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<a href="${escapeAttr(href)}"${titleAttr}>${label}</a>`;
    };
    window.marked.setOptions({ gfm: true, breaks: true, renderer });
  } catch (error) {
    console.warn('Typst Side Agent Markdown setup failed:', error?.message || String(error));
  }
}
