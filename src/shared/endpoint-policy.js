/** Shared validation for user-configured model/tool/MCP endpoints. */
export function validateEndpointUrl(input, options = {}) {
  let url;
  try { url = new URL(String(input || '')); }
  catch { return fail('INVALID_URL', 'Enter a valid HTTP(S) URL.'); }
  if (url.username || url.password) return fail('EMBEDDED_CREDENTIALS', 'Credentials are not allowed in endpoint URLs; use the dedicated key/headers field.');
  if (url.protocol === 'https:') return { ok: true, url: url.toString(), origin: url.origin, insecure: false };
  if (url.protocol !== 'http:') return fail('UNSUPPORTED_SCHEME', 'Only HTTPS and explicitly approved HTTP endpoints are supported.');
  if (isLoopbackHostname(url.hostname)) {
    return { ok: true, url: url.toString(), origin: url.origin, insecure: true, loopback: true };
  }
  const confirmedOrigin = typeof options.insecureConfirmedOrigin === 'string'
    ? options.insecureConfirmedOrigin
    : '';
  if (options.insecureConfirmed !== true && confirmedOrigin !== url.origin) {
    return fail('INSECURE_CONFIRMATION_REQUIRED', `HTTP sends credentials and project-derived data without transport encryption. Confirm this exact origin to continue: ${url.origin}`, { origin: url.origin });
  }
  return { ok: true, url: url.toString(), origin: url.origin, insecure: true, loopback: false };
}

/** Persist consent only for the exact non-loopback HTTP origin just reviewed. */
export function insecureAcknowledgementFields(endpoint, confirmed) {
  const origin = confirmed && endpoint?.insecure && !endpoint?.loopback
    ? endpoint.origin
    : null;
  return {
    insecureTransportAcknowledged: !!origin,
    insecureTransportAcknowledgedOrigin: origin
  };
}

/** Legacy boolean-only acknowledgements intentionally fail closed. */
export function normalizeInsecureAcknowledgement(record, endpointField) {
  const input = record?.[endpointField];
  const storedOrigin = typeof record?.insecureTransportAcknowledgedOrigin === 'string'
    ? record.insecureTransportAcknowledgedOrigin
    : '';
  const checked = validateEndpointUrl(input, { insecureConfirmedOrigin: storedOrigin });
  const origin = checked.ok && checked.insecure && !checked.loopback && storedOrigin === checked.origin
    ? checked.origin
    : null;
  return {
    ...record,
    insecureTransportAcknowledged: !!origin,
    insecureTransportAcknowledgedOrigin: origin
  };
}

export function isLoopbackHostname(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const m = h.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every(part => Number(part) <= 255);
}

export function validateHeaderRecord(headers, options = {}) {
  if (headers == null) return { ok: true, value: {} };
  if (typeof headers !== 'object' || Array.isArray(headers)) return fail('INVALID_HEADERS', 'Headers must be a JSON object.');
  const entries = Object.entries(headers);
  if (entries.length > 32) return fail('HEADER_LIMIT', 'At most 32 custom headers are allowed.');
  const protectedNames = new Set(options.mcp
    ? ['content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name']
    : ['content-type', 'content-length', 'host', 'origin']);
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) {
      return fail('INVALID_HEADER', 'Header names and values must be bounded single-line strings.');
    }
    if (protectedNames.has(lower) || lower.startsWith('sec-') || (options.mcp && lower.startsWith('mcp-param-'))) {
      return fail('PROTECTED_HEADER', `Header "${name}" is managed by the transport.`);
    }
  }
  return { ok: true, value: headers };
}

function fail(code, message, details) {
  return { ok: false, error: { code, path: '$', message, ...(details ? { details } : {}) } };
}
