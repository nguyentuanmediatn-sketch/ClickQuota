import { clickupPool } from '../src/clickup-pool.mjs';
import { executePooledUpstream, extractReplyText, resolveClickUpModel } from '../src/clickup-upstream.mjs';

async function main() {
  console.log('Workspaces in pool:', clickupPool.workspaces.length);
  const model = resolveClickUpModel('gpt-6.1-sol-CL');
  console.log('Resolved model:', model);
  const prompt = 'Xin chào, tr? l?i ng?n g?n trong 1 câu: 1 + 1 = m?y?';
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
  console.log('Reply:', reply);
}

main().catch(err => console.error('Error:', err.message));
