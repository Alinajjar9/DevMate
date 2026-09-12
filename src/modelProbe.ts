/** A small synthetic provider check. It never reads project files or executes returned tools. */
import { randomUUID } from 'crypto';
import { ask, askStream } from './api/client';
import type { AskRequest } from './api/types';
import { parseAgentToolCall } from './agentTools';

export type ModelProbeResult = {
  connection: string; tools: string; streaming: string; reasoning: string; detail: string;
};

export async function testModelConfiguration(
  backendUrl: string, settings: AskRequest['settings'], apiKey: string | undefined,
  signal: AbortSignal, transport = { ask, askStream }
): Promise<ModelProbeResult> {
  const result: ModelProbeResult = { connection: 'Not confirmed', tools: 'Not confirmed',
    streaming: 'Not tested', reasoning: 'Not confirmed', detail: '' };
  const request: AskRequest = {
    question: 'This is an isolated setup test. Call read_file exactly once for devmate-probe.txt. '
      + 'Then reply with only the testMarker from its result. Do not use other tools.',
    mode: 'ideas', scope: { type: 'project', items: [] },
    settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 2_048), timeoutSeconds: Math.min(settings.timeoutSeconds, 120) },
    enabledTools: ['read_file'], agentEditsEnabled: false
  };
  const timeout = (request.settings.timeoutSeconds + 30) * 1_000;
  const initial = await transport.ask(backendUrl, request, apiKey, timeout, signal);
  if (initial.status !== 'ok' || !initial.data) {
    result.detail = initial.message ?? 'The provider did not return a valid response.';
    return result;
  }
  result.connection = 'Confirmed';
  result.reasoning = settings.reasoningEffort === 'auto'
    ? 'Provider default accepted' : `${settings.reasoningEffort} accepted (reasoning itself is not inspected)`;
  const call = initial.data.toolCalls?.[0];
  if (initial.data.toolCalls?.length !== 1 || call?.name !== 'read_file' || call.arguments?.path !== 'devmate-probe.txt'
    || (initial.data.changes?.length ?? 0) !== 0) {
    result.detail = 'The provider answered, but did not produce the requested test tool call. No tools were executed.';
    return result;
  }
  const marker = randomUUID();
  try {
    const parsed = parseAgentToolCall(call);
    if (parsed.name !== 'read_file' || Object.keys(call.arguments).some(key => !['path', 'startLine', 'endLine'].includes(key))) {
      throw new Error('The synthetic file check only accepts read_file arguments.');
    }
    for (const key of ['startLine', 'endLine'] as const) {
      if (call.arguments[key] !== undefined && (call.arguments[key] !== parsed.arguments[key]
        || !Number.isInteger(call.arguments[key]) || (call.arguments[key] as number) < 1)) {
        throw new Error(`${key} must be a positive whole number without normalisation.`);
      }
    }
  } catch (error) {
    result.detail = `The provider returned an invalid test tool call: ${error instanceof Error ? error.message : 'invalid arguments'}. No tools were executed.`;
    return result;
  }
  let textEvents = 0;
  const final = await transport.askStream(backendUrl, { ...request, enabledTools: [], forceFinalAnswer: true,
    toolHistory: [{ callId: call.id, name: call.name, arguments: call.arguments, isError: false,
      result: `Synthetic file result. testMarker: ${marker}`, providerState: call.providerState }]
  }, apiKey, timeout, signal, event => { if (event.type === 'delta' && event.text) textEvents += 1; });
  result.streaming = final.unsupported ? 'Unavailable on this backend'
    : textEvents > 0 ? 'Text events received' : 'No text events observed';
  if (final.result.status !== 'ok' || !final.result.data) {
    result.detail = final.result.message ?? 'The tool continuation did not complete.';
    return result;
  }
  if (final.result.data.toolCalls?.length || final.result.data.changes?.length) {
    result.detail = 'The model requested work after the tool check should have finished. Nothing was executed.';
    return result;
  }
  result.tools = final.result.data.answer.includes(marker) ? 'Round trip confirmed' : 'Call accepted; result use not confirmed';
  result.detail = 'Used at most two small synthetic model requests (up to 2048 output tokens each). '
    + 'No project files or commands were used. This checks this configuration, not every capability of the model.';
  return result;
}
