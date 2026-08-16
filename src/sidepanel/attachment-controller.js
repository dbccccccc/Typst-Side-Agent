import { LIMITS } from '../shared/constants.js';
import { PROTOCOL } from '../shared/protocol.js';
import { normalizeActiveEditorFile } from '../shared/active-file.js';

/** Owns attachment state, live refresh, model payloads, and persisted thumbnails. */
export function createAttachmentController({
  state,
  request,
  makeId,
  documentRef = globalThis.document,
  ImageCtor = globalThis.Image,
  thumbnailer = null
}) {
  if (!state || typeof request !== 'function' || typeof makeId !== 'function') throw new TypeError('Attachment controller dependencies are required.');
  const makeThumbnail = thumbnailer || (dataUrl => createHistoryThumbnail(dataUrl, { documentRef, ImageCtor }));

  function previewRequest(captureMode = 'auto', tabId = null) {
    const message = { type: PROTOCOL.GET_PREVIEW };
    if (captureMode === 'canvas') message.preferTypstCanvas = true;
    if (captureMode === 'asset') message.preferAssetImage = true;
    if (tabId != null) message.tabId = tabId;
    return message;
  }

  return Object.freeze({
    addSelection(text, activeFile = null) {
      const normalized = String(text || '').trim().slice(0, LIMITS.MAX_PAGE_SELECTION_CHARS);
      if (!normalized) return null;
      const sourceFile = normalizeActiveEditorFile(activeFile);
      const selection = { id: makeId(), text: normalized, ...(sourceFile ? { activeFile: sourceFile } : {}) };
      state.attachments.selections.push(selection);
      return selection;
    },
    removeSelection(id) {
      state.attachments.selections = state.attachments.selections.filter(item => item.id !== id);
    },
    addPreview({ dataUrl, captureMode = 'auto' }) {
      assertLivePreviewDataUrl(dataUrl);
      const preview = { id: makeId(), dataUrl, captureMode };
      state.attachments.previews.push(preview);
      return preview;
    },
    removePreview(id) {
      state.attachments.previews = state.attachments.previews.filter(item => item.id !== id);
    },
    clear() {
      state.attachments = { selections: [], previews: [] };
    },
    previewRequest,
    async refresh(tabId = null) {
      for (const preview of state.attachments.previews) {
        const result = await request(previewRequest(preview.captureMode, tabId));
        if (result?.error) throw new Error(result.error);
        assertLivePreviewDataUrl(result?.dataUrl);
        preview.dataUrl = result.dataUrl;
      }
      return state.attachments.previews;
    },
    composePayload() {
      const payload = {};
      const selections = state.attachments.selections
        .map(item => ({
          selectedText: item.text,
          ...(normalizeActiveEditorFile(item.activeFile) ? { activeFile: normalizeActiveEditorFile(item.activeFile) } : {})
        }))
        .filter(item => typeof item.selectedText === 'string' && item.selectedText.trim());
      const previews = state.attachments.previews
        .map(item => ({ dataUrl: item.dataUrl }))
        .filter(item => isLivePreviewDataUrl(item.dataUrl));
      if (selections.length) payload.selections = selections;
      if (previews.length) payload.previews = previews;
      return payload;
    },
    async buildHistorySnapshot(attachments) {
      const previews = [];
      for (const preview of (attachments?.previews || []).slice(0, LIMITS.MAX_PERSISTED_PREVIEWS_PER_MESSAGE)) previews.push(await makeThumbnail(preview?.dataUrl));
      return {
        selections: (attachments?.selections || [])
          .map(item => {
            const activeFile = normalizeActiveEditorFile(item?.activeFile);
            return {
              text: String(item?.selectedText || '').trim(),
              ...(activeFile ? { fileLabel: activeFile.relativePath } : {})
            };
          })
          .filter(item => item.text),
        previews
      };
    }
  });
}

export function isLivePreviewDataUrl(value) {
  return typeof value === 'string' && value.length <= LIMITS.MAX_PREVIEW_DATA_URL_CHARS &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(value);
}

function assertLivePreviewDataUrl(value) {
  if (!isLivePreviewDataUrl(value)) {
    throw new Error(`Preview image must be a local PNG, JPEG, or WebP data URL no larger than ${Math.floor(LIMITS.MAX_PREVIEW_DATA_URL_CHARS / (1024 * 1024))} MiB.`);
  }
}

export async function createHistoryThumbnail(dataUrl, { documentRef = globalThis.document, ImageCtor = globalThis.Image } = {}) {
  const omitted = reason => ({ omitted: true, reason });
  if (typeof dataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,/i.test(dataUrl)) {
    return omitted('Preview omitted from stored history because its image format was unsupported.');
  }
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new ImageCtor();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Image decode failed'));
      element.src = dataUrl;
    });
    const sourceWidth = Math.max(1, image.naturalWidth || image.width || 1);
    const sourceHeight = Math.max(1, image.naturalHeight || image.height || 1);
    const initialScale = Math.min(1, 256 / Math.max(sourceWidth, sourceHeight));
    let width = Math.max(1, Math.round(sourceWidth * initialScale));
    let height = Math.max(1, Math.round(sourceHeight * initialScale));
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = documentRef.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(image, 0, 0, width, height);
      for (const quality of [0.8, 0.65, 0.5]) {
        const thumbnail = canvas.toDataURL('image/webp', quality);
        if (thumbnail.length <= LIMITS.MAX_PERSISTED_PREVIEW_CHARS) return { dataUrl: thumbnail, width, height, mimeType: 'image/webp', thumbnail: true };
      }
      width = Math.max(1, Math.floor(width * 0.7));
      height = Math.max(1, Math.floor(height * 0.7));
    }
    return omitted('Preview omitted from stored history because a bounded thumbnail could not be created.');
  } catch {
    return omitted('Preview omitted from stored history because thumbnail creation failed.');
  }
}
