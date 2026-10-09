/** The header chat dropdown: list, switch, inline rename, and delete. */
export function createSessionMenu({ state, listSessions, renameSession, switchSession, deleteSession, setStatus, documentRef = globalThis.document }) {
  if (!state || ![listSessions, renameSession, switchSession, deleteSession].every(fn => typeof fn === 'function')) {
    throw new TypeError('Session menu requires state and session callbacks.');
  }
  const get = id => documentRef.getElementById(id);
  const report = error => setStatus?.(error?.message || String(error), true);

  function render(sessions) {
    const list = get('session-list');
    list.replaceChildren();
    for (const session of sessions) list.appendChild(buildItem(session));
    if (sessions.length === 0) {
      const empty = documentRef.createElement('div');
      empty.style.cssText = 'padding:10px;font-size:11px;color:var(--text-muted);text-align:center;';
      empty.textContent = 'No chats yet';
      list.appendChild(empty);
    }
  }

  async function refresh() {
    const sessions = await listSessions();
    if (Array.isArray(sessions)) render(sessions);
    return sessions;
  }

  function buildItem(session) {
    const item = documentRef.createElement('div');
    item.className = 'dropdown-item session-item' + (state.currentSession?.id === session.id ? ' active' : '');

    const name = documentRef.createElement('span');
    name.className = 'dropdown-item-name';
    name.textContent = session.name || 'Untitled';
    name.title = 'Open · double-click to rename';
    name.addEventListener('click', () => {
      Promise.resolve(switchSession(session)).catch(report);
      get('session-menu').classList.add('hidden');
    });
    name.addEventListener('dblclick', event => {
      event.stopPropagation();
      beginRename(item, session);
    });

    const renameBtn = documentRef.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'dropdown-item-rename';
    renameBtn.title = 'Rename';
    renameBtn.textContent = '✎';
    renameBtn.addEventListener('click', event => {
      event.stopPropagation();
      beginRename(item, session);
    });

    const del = documentRef.createElement('button');
    del.type = 'button';
    del.className = 'dropdown-item-del';
    del.title = 'Delete';
    del.textContent = '×';
    del.addEventListener('click', event => {
      event.stopPropagation();
      Promise.resolve(deleteSession(session.id)).catch(report);
    });

    item.append(name, renameBtn, del);
    return item;
  }

  function beginRename(itemEl, session) {
    if (itemEl.classList.contains('renaming')) return;
    itemEl.classList.add('renaming');
    const nameEl = itemEl.querySelector('.dropdown-item-name');
    const originalName = session.name || '';
    const input = documentRef.createElement('input');
    input.type = 'text';
    input.className = 'dropdown-item-rename-input';
    input.value = originalName;
    input.maxLength = 80;
    input.setAttribute('spellcheck', 'false');
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async commit => {
      if (finished) return;
      finished = true;
      itemEl.classList.remove('renaming');
      const newName = input.value.trim();
      try {
        if (commit && newName && newName !== originalName) await renameSession(session.id, newName);
        else await refresh();
      } catch (error) {
        report(error);
      }
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', event => event.stopPropagation());
  }

  return Object.freeze({ render, refresh });
}
