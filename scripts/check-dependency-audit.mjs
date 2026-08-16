import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const execFile = promisify(execFileCallback);
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

export function classifyAuditReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw coded('AUDIT_REPORT_INVALID', 'npm audit did not return a JSON object.');
  }
  if (report.error) {
    const message = typeof report.error === 'object' ? report.error.summary || report.error.detail : report.error;
    throw coded('AUDIT_COMMAND_FAILED', `npm audit failed: ${String(message || 'unknown audit error')}`);
  }
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    throw coded('AUDIT_REPORT_INVALID', 'npm audit JSON is missing its vulnerabilities map.');
  }

  const blocking = [];
  for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities)) {
    const severity = String(vulnerability?.severity || '').toLowerCase();
    if (!BLOCKING_SEVERITIES.has(severity)) continue;
    const advisoryIds = (Array.isArray(vulnerability.via) ? vulnerability.via : [])
      .filter(item => item && typeof item === 'object')
      .map(item => item.source)
      .filter(value => typeof value === 'number' || (typeof value === 'string' && value.length > 0))
      .map(String);
    blocking.push({ packageName, severity, advisoryIds: [...new Set(advisoryIds)].sort() });
  }
  blocking.sort((left, right) => left.packageName.localeCompare(right.packageName, 'en'));
  return { blocking };
}

async function defaultAuditCommand() {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = npmExecPath ? [npmExecPath, 'audit', '--json'] : ['audit', '--json'];
  try {
    const result = await execFile(command, args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : error?.message || String(error)
    };
  }
}

export async function checkDependencyAudit(options = {}) {
  const outcome = await (options.runAudit || defaultAuditCommand)();
  let report;
  try {
    report = JSON.parse(outcome.stdout);
  } catch {
    throw coded('AUDIT_REPORT_INVALID', `npm audit returned malformed JSON${outcome.stderr ? `: ${String(outcome.stderr).slice(0, 300)}` : '.'}`);
  }
  const result = classifyAuditReport(report);
  if (result.blocking.length) {
    const packages = result.blocking.map(item => `${item.packageName} (${item.severity})`).join(', ');
    throw coded('AUDIT_BLOCKED', `Release dependency audit found unwaived high/critical advisories: ${packages}`);
  }
  if (outcome.exitCode !== 0 && !report.metadata) {
    throw coded('AUDIT_COMMAND_FAILED', 'npm audit exited unsuccessfully without complete audit metadata.');
  }
  return result;
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  try {
    const result = await checkDependencyAudit();
    console.log(`Release dependency audit passed (${result.blocking.length} unwaived high/critical advisories).`);
  } catch (error) {
    console.error(`${error?.code || 'AUDIT_FAILED'}: ${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}
