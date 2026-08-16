import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLoopbackHostname, normalizeInsecureAcknowledgement, validateEndpointUrl, validateHeaderRecord
} from '../src/shared/endpoint-policy.js';
import { BUILTIN_TOOL_METADATA } from '../src/background/tools.js';

test('endpoint policy accepts HTTPS and loopback HTTP', () => {
  assert.equal(validateEndpointUrl('https://example.com/path').ok, true);
  for (const host of ['localhost', 'api.localhost', '127.0.0.1', '127.255.20.3', '::1']) assert.equal(isLoopbackHostname(host), true, host);
  assert.equal(validateEndpointUrl('http://localhost:7000/mcp').ok, true);
  assert.equal(validateEndpointUrl('http://[::1]:7000/mcp').ok, true);
});

test('endpoint policy rejects silent cleartext, credentials, and non-HTTP schemes', () => {
  const cleartext = validateEndpointUrl('http://192.168.1.5/tool');
  assert.equal(cleartext.error.code, 'INSECURE_CONFIRMATION_REQUIRED');
  assert.equal(cleartext.error.details.origin, 'http://192.168.1.5');
  assert.equal(validateEndpointUrl('http://192.168.1.5/tool', { insecureConfirmed: true }).ok, true);
  assert.equal(validateEndpointUrl('http://192.168.1.5/tool', { insecureConfirmedOrigin: 'http://192.168.1.5' }).ok, true);
  assert.equal(validateEndpointUrl('http://192.168.1.5/tool', { insecureConfirmedOrigin: 'http://other.example' }).error.code, 'INSECURE_CONFIRMATION_REQUIRED');
  assert.equal(normalizeInsecureAcknowledgement({ endpoint: 'http://192.168.1.5/tool', insecureTransportAcknowledged: true }, 'endpoint').insecureTransportAcknowledged, false);
  assert.equal(normalizeInsecureAcknowledgement({ endpoint: 'http://192.168.1.5/tool', insecureTransportAcknowledgedOrigin: 'http://192.168.1.5' }, 'endpoint').insecureTransportAcknowledged, true);
  assert.equal(validateEndpointUrl('https://user:pass@example.com').error.code, 'EMBEDDED_CREDENTIALS');
  assert.equal(validateEndpointUrl('file:///tmp/tool').error.code, 'UNSUPPORTED_SCHEME');
});

test('custom headers are bounded and cannot override transport headers', () => {
  assert.equal(validateHeaderRecord({ Authorization: 'Bearer test' }).ok, true);
  assert.equal(validateHeaderRecord({ Host: 'evil.example' }).error.code, 'PROTECTED_HEADER');
  assert.equal(validateHeaderRecord({ 'Mcp-Method': 'other' }, { mcp: true }).error.code, 'PROTECTED_HEADER');
  assert.equal(validateHeaderRecord({ Test: 'line\r\nbreak' }).error.code, 'INVALID_HEADER');
});

test('all built-ins declare explicit effects and editor writes require approval', () => {
  for (const [name, policy] of Object.entries(BUILTIN_TOOL_METADATA)) {
    assert.ok(['read', 'editor-write'].includes(policy.effect), name);
    if (policy.effect === 'read') assert.equal(policy.approval, 'automatic', name);
    else assert.equal(policy.approval, 'once', name);
  }
});
