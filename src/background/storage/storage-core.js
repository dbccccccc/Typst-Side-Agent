/**
 * Shared plumbing for every worker-owned storage domain: the adapter seam used
 * by tests, the single serialized mutation queue, bounded key helpers, and the
 * validation and formatting utilities the stores have in common.
 */
import { codedError } from '../../shared/errors.js';

const RECORD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

let adapterOverride = null;
let mutationQueue = Promise.resolve();
const resetHooks = new Set();

export function storage() {
  if (adapterOverride) return adapterOverride;
  return chrome.storage.local;
}

export function configureStorageAdapter(adapter) {
  adapterOverride = adapter;
  mutationQueue = Promise.resolve();
  for (const hook of resetHooks) hook();
}

export function resetStorageAdapter() {
  configureStorageAdapter(null);
}

/** Stores with their own cached state register a hook so adapter swaps reset it. */
export function onStorageAdapterReset(hook) {
  resetHooks.add(hook);
  return () => resetHooks.delete(hook);
}

export async function readKey(key, fallback) {
  const result = await storage().get(key);
  return result?.[key] ?? fallback;
}

export async function writeKey(key, value) {
  try {
    await storage().set({ [key]: value });
  } catch (error) {
    throw storageError(error);
  }
}

export async function removeKey(key) {
  try { await storage().remove(key); }
  catch (error) { throw storageError(error); }
}

export async function listStorageKeys() {
  return typeof storage().getKeys === 'function'
    ? storage().getKeys()
    : Object.keys(await storage().get(null) || {});
}

/** Every mutation runs on one queue so interleaved writers cannot lose an index update. */
export function enqueueMutation(operation) {
  const next = mutationQueue.then(operation, operation);
  mutationQueue = next.catch(() => {});
  return next;
}

export function isRecordId(value) {
  return RECORD_ID_PATTERN.test(String(value || ''));
}

export function validSha256(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

export function finiteTime(value) {
  return Number.isFinite(value) && value >= 0 ? value : Date.now();
}

export function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

export function stableId(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

export function storageError(error) {
  const message = error?.message || String(error);
  if (/quota|QUOTA_BYTES/i.test(message)) {
    return codedError(
      'STORAGE_QUOTA_EXCEEDED',
      'Chrome local-storage quota was exceeded. The current in-memory chat is unsaved; export or delete old sessions and retry.'
    );
  }
  return codedError('STORAGE_WRITE_FAILED', `Could not save local data: ${message}`);
}

export async function restrictStorageAccess() {
  const local = storage();
  if (typeof local.setAccessLevel !== 'function') return { ok: false, unsupported: true };
  try {
    await local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    return { ok: true };
  } catch (error) {
    console.warn('Typst Side Agent could not restrict storage access:', error?.message || String(error));
    return { ok: false, error: error?.message || String(error) };
  }
}
