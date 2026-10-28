import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResponsesOutput,
  buildResponsesResponse,
  buildResponsesUsage,
  clearResponsesHistoryForTests,
  createResponsesContext,
  normalizeResponsesRequest,
  rememberResponsesConversation,
} from '../src/protocols/openai-responses.mjs';
import { messagesToPrompt } from '../src/providers/clickup/upstream.mjs';

test('normalizes Responses string input and instructions', () => {
  const normalized = normalizeResponsesRequest({
    model: 'gpt-6-luna-CL',
    instructions: 'Follow the project rules.',
    input: 'Inspect the repository.',
    max_output_tokens: 512,
  });

  assert.equal(normalized.isResponses, true);
  assert.equal(normalized.max_tokens, 512);
  assert.deepEqual(normalized.messages, [
    { role: 'system', content: 'Follow the project rules.' },
    { role: 'user', content: 'Inspect the repository.' },
  ]);
});

test('normalizes Codex function-call history without losing tool results', () => {
  const normalized = normalizeResponsesRequest({
    model: 'gpt-6-luna-CL',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read README.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"README.md"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ClickQuota documentation' },
    ],
  });

  assert.deepEqual(normalized.messages[1], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'README.md' } }],
  });
  assert.deepEqual(normalized.messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ClickQuota documentation' }],
  });
});

test('builds standard Responses output and usage envelopes', () => {
  const context = createResponsesContext('request-123', 123456);
  const output = buildResponsesOutput({
    context,
    text: 'Checking now.',
    toolCalls: [{ id: 'call_1', name: 'Read', input: { file_path: 'README.md' } }],
  });
  const response = buildResponsesResponse({
    context,
    rawBody: { model: 'gpt-6-luna-CL', tools: [{ type: 'function', name: 'Read' }] },
    model: 'gpt-6-luna-CL',
    output,
    usage: buildResponsesUsage(10, 4),
  });

  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.equal(response.output[0].content[0].type, 'output_text');
  assert.equal(response.output[1].type, 'function_call');
  assert.equal(response.output[1].arguments, '{"file_path":"README.md"}');
  assert.equal(response.usage.total_tokens, 14);
});

test('preserves OpenAI Chat tool-call and tool-result history', () => {
  const prompt = messagesToPrompt([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_7', type: 'function', function: { name: 'Read', arguments: '{"file_path":"README.md"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_7', content: 'README contents' },
  ]);

  assert.match(prompt, /tool_call id="call_7"/);
  assert.match(prompt, /tool_result id="call_7"/);
  assert.match(prompt, /README contents/);
});

test('rejects missing or empty Responses input', () => {
  assert.throws(() => normalizeResponsesRequest({ model: 'gpt-6-luna-CL' }), /input is required/);
  assert.throws(() => normalizeResponsesRequest({ input: [] }), /input must not be empty/);
});

test('continues context through previous_response_id and rejects expired IDs', () => {
  clearResponsesHistoryForTests();
  const first = normalizeResponsesRequest({
    instructions: 'Do not repeat yourself.',
    input: 'My project is ClickQuota.',
  });
  const context = createResponsesContext('history-1');
  const output = buildResponsesOutput({ context, text: 'Understood.' });
  rememberResponsesConversation({
    responseId: context.responseId,
    messages: first.messages,
    output,
  });

  const next = normalizeResponsesRequest({
    previous_response_id: context.responseId,
    input: 'What is my project?',
  });
  assert.deepEqual(next.messages, [
    { role: 'user', content: 'My project is ClickQuota.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }] },
    { role: 'user', content: 'What is my project?' },
  ]);
  assert.throws(
    () => normalizeResponsesRequest({ previous_response_id: 'resp_missing', input: 'Continue' }),
    /unknown or expired/,
  );
  clearResponsesHistoryForTests();
});
