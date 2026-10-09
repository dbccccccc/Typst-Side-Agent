/**
 * One structured-error shape for every extension context. Boundaries translate
 * these into `{ ok: false, error: { code, message, details? } }` responses.
 */
export function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details != null) error.details = details;
  return error;
}
