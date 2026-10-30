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

test('generates stable call_id for function_call without id and rejects function_call_output without call_id', () => {
  const normalized = normalizeResponsesRequest({
    input: [
      { type: 'function_call', name: 'search_files', arguments: '{"q":"main"}' },
    ],
  });
  const assistantMsg = normalized.messages[0];
  assert.equal(assistantMsg.role, 'assistant');
  assert.ok(assistantMsg.content[0].id.startsWith('call_'));
  assert.notEqual(assistantMsg.content[0].id, '');

  assert.throws(
    () => normalizeResponsesRequest({ input: [{ type: 'function_call_output', output: 'ok' }] }),
    /call_id is required/,
  );
});

test('merges consecutive function_call items into one assistant message', () => {
  const normalized = normalizeResponsesRequest({
    input: [
      { type: 'message', role: 'user', content: 'Run tasks.' },
      { type: 'function_call', call_id: 'c1', name: 'Task1', arguments: '{}' },
      { type: 'function_call', call_id: 'c2', name: 'Task2', arguments: '{}' },
    ],
  });

  assert.equal(normalized.messages.length, 2);
  assert.equal(normalized.messages[1].role, 'assistant');
  assert.equal(normalized.messages[1].content.length, 2);
  assert.equal(normalized.messages[1].content[0].id, 'c1');
  assert.equal(normalized.messages[1].content[1].id, 'c2');
});

test('merges consecutive function_call_output items into one user message', () => {
  const normalized = normalizeResponsesRequest({
    input: [
      { type: 'function_call', call_id: 'c1', name: 'Task1', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'res1' },
      { type: 'function_call_output', call_id: 'c2', output: 'res2' },
    ],
  });

  assert.equal(normalized.messages.length, 2);
  assert.equal(normalized.messages[1].role, 'user');
  assert.equal(normalized.messages[1].content.length, 2);
  assert.equal(normalized.messages[1].content[0].tool_use_id, 'c1');
  assert.equal(normalized.messages[1].content[1].tool_use_id, 'c2');
});

test('parseArguments repairs buffer and rejects invalid JSON', () => {
  // Repaired JSON (unclosed quote and brace)
  const normalized = normalizeResponsesRequest({
    input: [
      { type: 'function_call', call_id: 'c1', name: 'Task', arguments: '{"key": "value' },
    ],
  });
  assert.deepEqual(normalized.messages[0].content[0].input, { key: 'value' });

  // Completely invalid JSON throws invalid_request error
  assert.throws(
    () => normalizeResponsesRequest({
      input: [{ type: 'function_call', call_id: 'c1', name: 'Task', arguments: '###NOT_JSON###' }],
    }),
    /Failed to parse tool arguments as JSON/,
  );
});

test('reasoning summary is not injected as regular assistant message', () => {
  const normalized = normalizeResponsesRequest({
    input: [
      { type: 'reasoning', summary: 'Thinking step by step...' },
      { type: 'message', role: 'user', content: 'Hello' },
    ],
  });

  assert.equal(normalized.messages.length, 1);
  assert.equal(normalized.messages[0].role, 'user');
  assert.equal(normalized.messages[0].content, 'Hello');
});

test('handles item_reference from previous responses and rejects unknown item types', () => {
  clearResponsesHistoryForTests();
  const context = createResponsesContext('test-ref');
  const output = buildResponsesOutput({
    context,
    text: 'Done step 1.',
    toolCalls: [{ id: 'fc_saved_1', name: 'Read', input: { path: 'a.txt' } }],
  });
  rememberResponsesConversation({
    responseId: context.responseId,
    messages: [{ role: 'user', content: 'Step 1' }],
    output,
  });

  // Reference existing tool call
  const withRef = normalizeResponsesRequest({
    input: [
      { type: 'item_reference', id: 'fc_testref_0' },
      { type: 'function_call_output', call_id: 'fc_saved_1', output: 'content' },
    ],
  });
  assert.equal(withRef.messages[0].role, 'assistant');
  assert.equal(withRef.messages[0].content[0].type, 'tool_use');

  // Unknown item type throws 400
  assert.throws(
    () => normalizeResponsesRequest({ input: [{ type: 'alien_type', foo: 'bar' }] }),
    /Unsupported item type/,
  );

  // Missing item reference throws 400
  assert.throws(
    () => normalizeResponsesRequest({ input: [{ type: 'item_reference', id: 'fc_non_existent' }] }),
    /unknown or expired/,
  );

  clearResponsesHistoryForTests();
});

test('hoists mid-conversation developer and system messages to the beginning', () => {
  const normalized = normalizeResponsesRequest({
    instructions: 'Base instructions.',
    input: [
      { type: 'message', role: 'user', content: 'First query.' },
      { type: 'message', role: 'developer', content: 'Rule: be brief.' },
      { type: 'message', role: 'assistant', content: 'Understood.' },
      { type: 'message', role: 'system', content: 'Rule 2: output JSON.' },
      { type: 'message', role: 'user', content: 'Second query.' },
    ],
  });

  assert.equal(normalized.messages[0].role, 'system');
  assert.match(normalized.messages[0].content, /Base instructions\./);
  assert.match(normalized.messages[0].content, /Rule: be brief\./);
  assert.match(normalized.messages[0].content, /Rule 2: output JSON\./);

  // Ensure no system messages remain in the rest of conversation
  for (let i = 1; i < normalized.messages.length; i++) {
    assert.notEqual(normalized.messages[i].role, 'system');
  }
});
