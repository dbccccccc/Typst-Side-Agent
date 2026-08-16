import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDependencyAudit, classifyAuditReport } from '../scripts/check-dependency-audit.mjs';

const report = vulnerabilities => ({
  auditReportVersion: 2,
  vulnerabilities,
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } }
});

test('release audit accepts a complete report without high or critical advisories', async () => {
  const clean = report({ 'moderate-only': { severity: 'moderate', via: [], nodes: ['node_modules/moderate-only'] } });
  assert.deepEqual(classifyAuditReport(clean), { blocking: [] });
  assert.deepEqual(await checkDependencyAudit({
    runAudit: async () => ({ exitCode: 0, stdout: JSON.stringify(clean), stderr: '' })
  }), { blocking: [] });
});

test('release audit blocks high and critical packages with bounded identifying output', async () => {
  const vulnerable = report({
    renderer: { severity: 'critical', via: [{ source: 123, severity: 'critical' }], nodes: ['node_modules/renderer'] },
    testRunner: { severity: 'high', via: [{ source: 456, severity: 'high' }], nodes: ['node_modules/testRunner'] }
  });
  assert.deepEqual(classifyAuditReport(vulnerable).blocking, [
    { packageName: 'renderer', severity: 'critical', advisoryIds: ['123'] },
    { packageName: 'testRunner', severity: 'high', advisoryIds: ['456'] }
  ]);
  await assert.rejects(checkDependencyAudit({
    runAudit: async () => ({ exitCode: 1, stdout: JSON.stringify(vulnerable), stderr: '' })
  }), error => error.code === 'AUDIT_BLOCKED' && /renderer \(critical\)/.test(error.message));
});

test('release audit fails closed on malformed reports and command errors', async () => {
  await assert.rejects(checkDependencyAudit({
    runAudit: async () => ({ exitCode: 1, stdout: 'not-json', stderr: 'network unavailable' })
  }), error => error.code === 'AUDIT_REPORT_INVALID');
  await assert.rejects(checkDependencyAudit({
    runAudit: async () => ({ exitCode: 1, stdout: JSON.stringify({ error: { summary: 'registry unavailable' } }), stderr: '' })
  }), error => error.code === 'AUDIT_COMMAND_FAILED');
  assert.throws(() => classifyAuditReport({ metadata: {} }), error => error.code === 'AUDIT_REPORT_INVALID');
});
