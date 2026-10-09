/** Model endpoint validation shared by runs and session-title requests. */
import { validateEndpointUrl } from '../../shared/endpoint-policy.js';
import { codedError } from '../../shared/errors.js';

export function validateModel(modelConfig) {
  if (!modelConfig) throw codedError('MODEL_MISSING', 'No model configured. Add one in Settings.');
  const complete = [modelConfig.apiBaseUrl, modelConfig.apiKey, modelConfig.modelId].every(value => String(value || '').trim());
  if (!complete) throw codedError('MODEL_INCOMPLETE', 'Active model is missing base URL, API key, or model ID.');
  const endpoint = validateEndpointUrl(modelConfig.apiBaseUrl, {
    insecureConfirmedOrigin: modelConfig.insecureTransportAcknowledgedOrigin
  });
  if (!endpoint.ok) throw codedError(endpoint.error.code, endpoint.error.message, endpoint.error.details);
  return endpoint;
}

export function chatCompletionsUrl(endpoint) {
  return endpoint.url.replace(/\/+$/, '') + '/chat/completions';
}
