import { parseToolArguments } from '../shared/tool-validation.js';

function lineRange(call) {
  const parsed = call.parsedArgs ? { ok: true, value: call.parsedArgs } : parseToolArguments(call.rawArgs || '');
  const start = parsed.value?.start_line;
  const end = parsed.value?.end_line;
  return parsed.ok && Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start
    ? { start, end }
    : null;
}

function safelyReorder(group) {
  const ranges = group.map(lineRange);
  if (ranges.some(range => !range)) return false;
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  return ranges.every((range, index) => index === 0 || range.start > ranges[index - 1].end);
}

/**
 * Preserve provider order across every stateful/tool boundary. The only safe
 * optimization is a contiguous group of line replacements against the same
 * currently open document, which executes bottom-to-top so line numbers do
 * not shift under later calls.
 */
export function planToolCallsForExecution(toolCalls) {
  const planned = [];
  for (let index = 0; index < toolCalls.length;) {
    if (toolCalls[index]?.name !== 'replace_lines') {
      planned.push(toolCalls[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < toolCalls.length && toolCalls[end]?.name === 'replace_lines') end += 1;
    const group = toolCalls.slice(index, end);
    planned.push(...(safelyReorder(group)
      ? group.map((call, offset) => ({ call, offset, range: lineRange(call) }))
        .sort((left, right) => right.range.start - left.range.start || left.offset - right.offset)
        .map(item => item.call)
      : group));
    index = end;
  }
  return planned;
}
