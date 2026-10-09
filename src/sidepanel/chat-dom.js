/** Small DOM helpers shared by the chat renderer modules. */
const FOLLOW_THRESHOLD_PX = 72;

export const $ = id => document.getElementById(id);

export function scrollToBottom() {
  const el = $('messages');
  el.scrollTop = el.scrollHeight;
  $('jump-latest')?.classList.add('hidden');
}

export function isNearBottom() {
  const el = $('messages');
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
}

/** Keep following the stream only while the reader was already near the bottom. */
export function finishDomMutation(wasNearBottom) {
  if (wasNearBottom) scrollToBottom();
  else $('jump-latest')?.classList.remove('hidden');
}

/** Create an element whose markup is a constant SVG string owned by the extension. */
export function iconElement(className, svgMarkup) {
  const element = document.createElement('span');
  element.className = className;
  element.setAttribute('aria-hidden', 'true');
  element.innerHTML = svgMarkup;
  return element;
}

/** Markup for one of the extension's own stroke icons; the paths are constants, never user data. */
export function svgIcon(size, strokeWidth, paths, className = '') {
  const classAttr = className ? ` class="${className}"` : '';
  return `<svg${classAttr} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
    + ` stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
