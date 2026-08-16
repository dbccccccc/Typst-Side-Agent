/** Render a validated unified diff using text-only DOM operations. */
export function renderEditDiffPreview(preview) {
  const shell = document.createElement('section');
  shell.className = 'edit-diff';
  shell.setAttribute('aria-label', `Proposed changes to ${preview.fileLabel}`);

  const header = document.createElement('div');
  header.className = 'edit-diff-header';
  const file = document.createElement('span');
  file.className = 'edit-diff-file';
  file.textContent = preview.fileLabel;
  file.title = preview.fileLabel;
  const stats = document.createElement('span');
  stats.className = 'edit-diff-stats';
  const additions = document.createElement('span');
  additions.className = 'edit-diff-additions';
  additions.textContent = `+${preview.additions}`;
  const deletions = document.createElement('span');
  deletions.className = 'edit-diff-deletions';
  deletions.textContent = `−${preview.deletions}`;
  stats.append(additions, deletions);
  header.append(file, stats);

  const body = document.createElement('div');
  body.className = 'edit-diff-body';
  body.tabIndex = 0;
  for (const hunk of preview.hunks) {
    const hunkHeader = document.createElement('div');
    hunkHeader.className = 'edit-diff-hunk-header';
    hunkHeader.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    body.appendChild(hunkHeader);
    for (const row of hunk.rows) {
      const line = document.createElement('div');
      line.className = `edit-diff-row edit-diff-${row.kind}`;
      const oldLine = document.createElement('span');
      oldLine.className = 'edit-diff-line-number';
      oldLine.textContent = row.oldLine == null ? '' : String(row.oldLine);
      const newLine = document.createElement('span');
      newLine.className = 'edit-diff-line-number';
      newLine.textContent = row.newLine == null ? '' : String(row.newLine);
      const marker = document.createElement('span');
      marker.className = 'edit-diff-marker';
      marker.textContent = row.kind === 'insert' ? '+' : row.kind === 'delete' ? '−' : ' ';
      const code = document.createElement('span');
      code.className = 'edit-diff-code';
      code.textContent = row.text;
      line.append(oldLine, newLine, marker, code);
      body.appendChild(line);
    }
  }
  shell.append(header, body);
  return shell;
}
