/** Collapsible "Thinking" block for provider reasoning text. */
import { svgIcon } from './chat-dom.js';

const REASONING_FOLLOW_THRESHOLD_PX = 2;
const reasoningScrollStates = new WeakMap();
const REASONING_ICON = svgIcon(13, 2,
  '<path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v.27a3 3 0 0 0-2.83 4.66 3 3 0 0 0 .58 4.91 3 3 0 0 0 1.5 4.94 3 3 0 0 0 5.25 2.04V4.5A2.5 2.5 0 0 0 9.5 2z"/>'
  + '<path d="M14.5 2A2.5 2.5 0 0 1 17 4.5v.27a3 3 0 0 1 2.83 4.66 3 3 0 0 1-.58 4.91 3 3 0 0 1-1.5 4.94 3 3 0 0 1-5.25 2.04V4.5A2.5 2.5 0 0 1 14.5 2z"/>'
);
const CARET_ICON = svgIcon(12, 2, '<path d="m6 9 6 6 6-6"/>', 'reasoning-caret');

/**
 * Build a collapsible "Thinking" block.
 * @param {string} text initial text content (may be empty for live streaming)
 * @param {boolean} live when true, render expanded with a pulsing indicator
 */
export function renderReasoningBlock(text, live) {
  const el = document.createElement('div');
  el.className = 'reasoning-block' + (live ? ' is-live' : '');

  const header = document.createElement('div');
  header.className = 'reasoning-header';
  header.innerHTML = `
    <span class="reasoning-icon">${REASONING_ICON}</span>
    <span class="reasoning-title">${live ? 'Thinking' : 'Thought'}</span>
    <span class="reasoning-meta"></span>
    ${CARET_ICON}
  `;

  const body = document.createElement('pre');
  body.className = 'reasoning-body';
  body.textContent = text || '';

  if (live) {
    const scrollState = { follow: true };
    reasoningScrollStates.set(body, scrollState);
    body.addEventListener('scroll', () => {
      const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
      scrollState.follow = distanceFromBottom <= REASONING_FOLLOW_THRESHOLD_PX;
    }, { passive: true });
    el.classList.add('open');
  }

  el.appendChild(header);
  el.appendChild(body);
  header.addEventListener('click', () => el.classList.toggle('open'));
  updateReasoningMeta(el);
  return el;
}

export function finishReasoningMutation(body) {
  const scrollState = reasoningScrollStates.get(body);
  if (scrollState?.follow) body.scrollTop = body.scrollHeight;
}

export function updateReasoningMeta(el) {
  const body = el.querySelector('.reasoning-body');
  const meta = el.querySelector('.reasoning-meta');
  if (!body || !meta) return;
  const chars = body.textContent.length;
  if (!chars) { meta.textContent = ''; return; }
  meta.textContent = chars > 1024 ? `${(chars / 1024).toFixed(1)}k chars` : `${chars} chars`;
}
