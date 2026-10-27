import { clickupPool } from '../src/clickup-pool.mjs';
import { executePooledUpstream, extractReplyText, resolveClickUpModel } from '../src/clickup-upstream.mjs';

async function main() {
  const model = resolveClickUpModel('super-agent-CL');
  console.log('Testing model:', model);
  const prompt = 'B?n là AI Agent. Hãy gi?i thích ng?n g?n cách b?n th?c thi m?t tác v?.';
  const payload = {
    operationName: 'AIRequest',
    variables: {
      type: 'CHAT_COMPLETION',
      input: {
        model,
        selectedModel: model,
        prompt,
        text: prompt,
        messages: [{ role: 'user', content: prompt }]
      }
    },
    query: `query AIRequest($type: AIRequestType!, $input: JSONObject!) {
  aiRequest(type: $type, input: $input) {
    completionString
    reasoning
    errors
  }
}`
  };

  const start = Date.now();
  const res = await executePooledUpstream({ payload });
  const reply = extractReplyText(res.parsed);
  console.log('Used workspace:', res.workspace?.label);
  console.log('Latency:', Date.now() - start, 'ms');
  console.log('Reply:\n', reply);
}

main().catch(err => console.error('Error:', err.message));
