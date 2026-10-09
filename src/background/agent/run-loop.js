/**
 * The per-run orchestration loop: admit the reserved run, build the registry
 * and conversation, stream provider rounds, dispatch validated tool calls in
 * plan order, and settle exactly one terminal event.
 */
import { LIMITS, TYPST_APP_PREFIX, normalizeEditorApprovalMode } from '../../shared/constants.js';
import { PROTOCOL, buildRunEvent, validateRunReserveEnvelope, validateRunStartEnvelope } from '../../shared/protocol.js';
import { isAbortError, raceWithSignal, throwIfAborted } from '../../shared/abort.js';
import { activeEditorFileFromContext, normalizeActiveEditorFile } from '../../shared/active-file.js';
import { codedError } from '../../shared/errors.js';
import { parseAndValidateToolArguments, parseToolArguments } from '../../shared/tool-validation.js';
import { buildMessages, buildSystemMessage, modelReasoningReplayEnabled } from '../context.js';
import { streamProviderRound } from '../provider.js';
import { createStreamBatcher } from '../stream-batcher.js';
import { planToolCallsForExecution } from '../tool-execution-plan.js';
import { buildToolRegistry } from '../tool-registry.js';
import { adapters } from './agent-adapters.js';
import { runEditorTool } from './editor-tool-runner.js';
import { discoverMcpToolset, executeCustomTool, executeMcpTool } from './external-tool-runner.js';
import { chatCompletionsUrl, validateModel } from './model-config.js';
import { createCompletedResponseSnapshot, forwardToTab, invalidateDivergedAutomaticSnapshot } from './page-bridge.js';
import {
  executeOpenProjectFile, executeReadDiagnostics, executeReadDocument, executeReadFileStructure, executeReadTypstDocs
} from './read-tool-runner.js';
import { emit } from './run-events.js';
import { runCoordinator, runIdentity, runs } from './run-registry.js';
import { buildTranscriptEntry, createRunTranscript } from './run-transcript.js';
import { authorizeTool, cleanupRunWaiters, waitForCapabilities } from './tool-preflight.js';

export const sortToolCallsForExecution = planToolCallsForExecution;

export function reserveRun(message) {
  const checked = validateRunReserveEnvelope(message);
  if (!checked.ok) throw codedError(checked.error.code, checked.error.message);
  const result = runCoordinator.reserve(runIdentity(message));
  if (!result.ok) throw codedError(result.code, result.error);
  return result;
}

function latestUserActiveEditorFile(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue;
    return normalizeActiveEditorFile(messages[index].activeEditorFile);
  }
  return null;
}

function attachReasoningContentToAssistantTurn(message, reasoning, modelConfig) {
  if (typeof reasoning === 'string' && reasoning) message.reasoning_content = reasoning;
  else if (modelReasoningReplayEnabled(modelConfig) && message.tool_calls?.length) message.reasoning_content = '';
}

function serializeToolResult(result) {
  let text;
  try { text = JSON.stringify(result); }
  catch { text = JSON.stringify({ ok: false, code: 'TOOL_RESULT_SERIALIZE_ERROR', error: 'Tool result could not be serialized.' }); }
  if (text.length <= LIMITS.MAX_TOOL_RESULT_MODEL_CHARS) return text;
  const previewLimit = Math.floor(LIMITS.MAX_TOOL_RESULT_MODEL_CHARS / 4);
  return JSON.stringify({
    ok: result?.ok !== false,
    truncated: true,
    original_chars: text.length,
    preview: text.slice(0, previewLimit)
  });
}

async function persistRunTranscript(run, responseStatus = 'incomplete') {
  const entry = buildTranscriptEntry(run, responseStatus);
  if (entry) {
    await adapters.persistRunTranscript({
      runId: run.runId,
      projectId: run.projectId,
      sessionId: run.sessionId,
      sourceMessages: run.sourceMessages,
      entry
    });
  }
  run.transcriptPersisted = true;
}

function createRun(message) {
  const payload = message.payload;
  const controller = new AbortController();
  return {
    runId: message.runId,
    tabId: payload.tabId,
    projectId: payload.projectId,
    sessionId: payload.sessionId,
    controller,
    signal: controller.signal,
    startedAt: adapters.now(),
    tabUrl: null,
    editorApprovalMode: normalizeEditorApprovalMode(payload.settings?.editorApprovalMode),
    allowedTools: new Set(),
    seenToolCallIds: new Set(),
    terminal: false,
    batcher: null,
    sourceMessages: payload.messages,
    transcript: createRunTranscript(),
    transcriptPersisted: false,
    editCheckpoint: null,
    activeEditorFile: normalizeActiveEditorFile(payload.activeEditorFile) || latestUserActiveEditorFile(payload.messages)
  };
}

async function captureOriginatingTab(run) {
  const tab = await raceWithSignal(adapters.tabsGet(run.tabId), run.signal);
  if (!tab?.url?.startsWith(TYPST_APP_PREFIX)) throw codedError('INVALID_RUN_TAB', 'The originating tab is no longer a typst.app tab.');
  run.tabUrl = tab.url;
  throwIfAborted(run.signal);
  const initialLiveState = await invalidateDivergedAutomaticSnapshot(run).catch(() => null);
  if (!run.activeEditorFile) run.activeEditorFile = initialLiveState?.activeFile || null;
  if (!run.activeEditorFile) {
    const identityContext = await forwardToTab(run, PROTOCOL.PAGE_GET_CONTEXT, {
      projection: 'numbered', startLine: 1, endLine: 1, maxChars: 1
    }).catch(() => null);
    run.activeEditorFile = activeEditorFileFromContext(identityContext);
  }
}

async function buildRunRegistry(run) {
  const [customTools, mcpEntries] = await raceWithSignal(Promise.all([
    adapters.loadCustomTools(),
    discoverMcpToolset(run)
  ]), run.signal);
  throwIfAborted(run.signal);
  const enabledCustom = customTools.filter(tool => tool.enabled !== false);
  const registry = buildToolRegistry({ customTools: enabledCustom, mcpEntries });
  const fatal = registry.errors.filter(error => error.code !== 'INVALID_MCP_SCHEMA');
  if (fatal.length) throw codedError('TOOL_REGISTRY_INVALID', fatal.map(error => error.message).join(' '), fatal);
  return registry;
}

async function runToolRound(run, response, registry, conversation, modelConfig) {
  run.batcher.flush();
  for (const call of response.toolCalls) {
    if (run.seenToolCallIds.has(call.id)) throw codedError('PROVIDER_DUPLICATE_TOOL_CALL_ID', 'Provider reused a tool-call id during this run.');
    run.seenToolCallIds.add(call.id);
  }

  const displayCalls = response.toolCalls.map(call => {
    const parsed = parseToolArguments(call.rawArgs);
    return { id: call.id, name: call.name, args: parsed.ok ? parsed.value : { invalid: true, error: parsed.error.message } };
  });
  emit(run, PROTOCOL.AI_TOOL_CALLS, { calls: displayCalls });
  const assistantTurn = {
    role: 'assistant',
    content: response.content || null,
    tool_calls: response.toolCalls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.rawArgs }
    }))
  };
  attachReasoningContentToAssistantTurn(assistantTurn, response.reasoning, modelConfig);
  conversation.push(assistantTurn);

  const results = new Map();
  for (const call of sortToolCallsForExecution(response.toolCalls)) {
    throwIfAborted(run.signal);
    const result = await executeToolDispatch(run, call, registry.routes);
    throwIfAborted(run.signal);
    results.set(call.id, result);
    run.batcher.flush();
    emit(run, PROTOCOL.AI_TOOL_RESULT, { callId: call.id, name: call.name, result });
  }
  for (const call of response.toolCalls) {
    conversation.push({
      role: 'tool',
      tool_call_id: call.id,
      content: serializeToolResult(results.get(call.id) || { ok: false, code: 'NOT_EXECUTED', error: 'Tool was not executed.' })
    });
  }
}

async function runConversation(run, payload) {
  const settings = payload.settings || {};
  const modelConfig = payload.modelConfig || settings.models?.find(model => model.id === settings.activeModelId) || settings.models?.[0];
  const modelEndpoint = validateModel(modelConfig);
  const registry = await buildRunRegistry(run);
  const conversation = buildMessages({
    systemMessage: buildSystemMessage({ settings }),
    attachments: payload.attachments || {},
    activeEditorFile: run.activeEditorFile,
    modelConfig,
    chatMessages: payload.messages,
    maxHistoryMessages: settings.maxHistoryMessages || 40
  });
  const providerUrl = chatCompletionsUrl(modelEndpoint);

  for (let round = 0; round < LIMITS.MAX_TOOL_ROUNDS; round++) {
    throwIfAborted(run.signal);
    const response = await streamProviderRound({
      url: providerUrl,
      apiKey: modelConfig.apiKey,
      modelId: modelConfig.modelId,
      messages: conversation,
      tools: registry.specs,
      signal: run.signal,
      modelConfig,
      fetchImpl: adapters.fetchImpl,
      onDelta: (channel, text) => run.batcher.push(channel, text)
    });
    if (!response.toolCalls) return;
    await runToolRound(run, response, registry, conversation, modelConfig);
  }
  throw codedError('TOOL_ROUND_LIMIT', `Agent exceeded ${LIMITS.MAX_TOOL_ROUNDS} tool rounds.`);
}

export async function handleStreamStart(message) {
  const checked = validateRunStartEnvelope(message);
  if (!checked.ok) throw codedError(checked.error.code, checked.error.message);
  const { runId } = message;
  const admission = runCoordinator.admit(runIdentity(message));
  if (!admission.ok) {
    if (admission.code === 'CANCELLED') {
      adapters.runtimeSend(buildRunEvent(PROTOCOL.AI_STREAM_CANCELLED, runId, { code: 'CANCELLED', message: 'Run cancelled.' }));
      return { ok: true, cancelled: true, runId };
    }
    throw codedError(admission.code, admission.error);
  }
  const run = createRun(message);
  runs.set(runId, run);
  run.batcher = createStreamBatcher({
    runId,
    emit: ({ items }) => emit(run, PROTOCOL.AI_STREAM_BATCH, { items }),
    setTimer: adapters.setTimeoutImpl,
    clearTimer: adapters.clearTimeoutImpl
  });

  try {
    await captureOriginatingTab(run);
    await runConversation(run, message.payload);
    run.batcher.flush();
    await persistRunTranscript(run, 'complete');
    const snapshotPayload = await createCompletedResponseSnapshot(run);
    run.terminal = true;
    emit(run, PROTOCOL.AI_STREAM_DONE, snapshotPayload, { terminal: true });
    return { ok: true, runId };
  } catch (caughtError) {
    let error = caughtError;
    run.batcher.flush();
    if (!run.transcriptPersisted) {
      try { await persistRunTranscript(run, 'incomplete'); }
      catch (persistError) {
        if (!error || error.code === 'CANCELLED' || isAbortError(error)) error = persistError;
      }
    }
    await invalidateDivergedAutomaticSnapshot(run).catch(() => {});
    run.terminal = true;
    if (run.signal.aborted || error.code === 'CANCELLED' || isAbortError(error)) {
      emit(run, PROTOCOL.AI_STREAM_CANCELLED, { code: 'CANCELLED', message: 'Run cancelled.' }, { terminal: true });
      return { ok: true, cancelled: true, runId };
    }
    emit(run, PROTOCOL.AI_STREAM_ERROR, { code: error.code || 'AGENT_ERROR', message: error.message || String(error) }, { terminal: true });
    return { ok: false, code: error.code || 'AGENT_ERROR', error: error.message || String(error), runId };
  } finally {
    run.batcher.cancel();
    cleanupRunWaiters(runId);
    if (runs.get(runId) === run) runs.delete(runId);
    runCoordinator.complete(runId);
  }
}

async function executeToolDispatch(run, call, routes) {
  if (!call?.id || !call?.name) return { ok: false, code: 'INVALID_TOOL_CALL', error: 'Tool call requires an id and function name.' };
  const route = routes.get(call.name);
  if (!route) return { ok: false, code: 'UNKNOWN_TOOL', error: `Unknown tool: ${call.name}` };
  const validated = parseAndValidateToolArguments(call.rawArgs, route.schema);
  if (!validated.ok) return { ok: false, code: validated.error.code, path: validated.error.path, error: validated.error.message };
  const args = validated.value;
  const preflight = await waitForCapabilities(run, call);
  if (!preflight.ok) return { ok: false, code: preflight.error.code, error: preflight.error.message };
  throwIfAborted(run.signal);

  if (route.effect === 'editor-write') return runEditorTool(run, call, route, args);

  const authorization = await authorizeTool(run, call, route, args);
  if (!authorization.ok) return { ok: false, code: authorization.error.code, error: authorization.error.message };

  switch (call.name) {
    case 'read_file_structure': return executeReadFileStructure(run, call);
    case 'open_project_file': return executeOpenProjectFile(run, call, args);
    case 'read_document': return executeReadDocument(run, call, args);
    case 'read_diagnostics': return executeReadDiagnostics(run);
    case 'read_typst_docs': return executeReadTypstDocs(args);
    default: break;
  }
  if (route.kind === 'custom') return executeCustomTool(run, route.source, args);
  if (route.kind === 'mcp') return executeMcpTool(run, route.source, args);
  return { ok: false, code: 'UNKNOWN_TOOL_KIND', error: `Unknown tool route for ${call.name}` };
}

export function abortRun(runId) {
  const ownership = runCoordinator.cancel(runId);
  const run = runs.get(runId);
  if (!run) return { ok: true, found: ownership.found, terminal: true };
  if (!run.signal.aborted) run.controller.abort(new DOMException('Cancelled by user', 'AbortError'));
  cleanupRunWaiters(runId, 'deny');
  return { ok: true, found: true, terminal: false };
}
