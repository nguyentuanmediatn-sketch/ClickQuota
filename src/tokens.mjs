import { countTokens, setMergeCacheSize } from 'gpt-tokenizer/encoding/o200k_base';

export const TOKEN_ESTIMATOR = 'gpt-tokenizer@4.0.0/o200k_base';
const literalSpecialTokens = { disallowedSpecial: new Set() };
setMergeCacheSize(1000);

// This measures the chosen encoding, not the private tokenizer or prompt inside Postman.
export function estimateTokens(value) {
  return countTokens(typeof value === 'string' ? value : JSON.stringify(value) ?? '', literalSpecialTokens);
}

export function contextMetrics(input, output, window) {
  if (input == null || !window) return { context_used_tokens_est: null, context_used_percent_est: null };
  const used = input + (output ?? 0);
  return { context_used_tokens_est: used, context_used_percent_est: Math.round(used / window * 10000) / 100 };
}
