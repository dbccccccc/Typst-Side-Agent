import { LIMITS } from '../shared/constants.js';

/** Parse a user-selected session export only after enforcing aggregate bounds. */
export async function readSessionImportFile(file) {
  if (!file || typeof file.text !== 'function') throw new Error('Choose a session export file');
  if (Number.isFinite(file.size) && file.size > LIMITS.MAX_SESSION_IMPORT_FILE_BYTES) {
    throw new Error(`File exceeds the ${formatBytes(LIMITS.MAX_SESSION_IMPORT_FILE_BYTES)} import limit`);
  }
  const text = await file.text();
  if (new TextEncoder().encode(text).length > LIMITS.MAX_SESSION_IMPORT_FILE_BYTES) {
    throw new Error(`File exceeds the ${formatBytes(LIMITS.MAX_SESSION_IMPORT_FILE_BYTES)} import limit`);
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('File is not valid JSON'); }
  const exportData = Array.isArray(parsed) ? parsed
                   : Array.isArray(parsed?.sessions) ? parsed
                   : null;
  if (!exportData) throw new Error('Unrecognised session export format');
  const records = Array.isArray(exportData) ? exportData : exportData.sessions;
  if (records.length > LIMITS.MAX_SESSION_IMPORT_RECORDS) {
    throw new Error(`Import exceeds the ${LIMITS.MAX_SESSION_IMPORT_RECORDS}-chat limit`);
  }
  return exportData;
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MiB`
    : `${Math.ceil(bytes / 1024)} KiB`;
}
