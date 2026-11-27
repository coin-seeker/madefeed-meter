import { expect, it } from 'vitest'
import { inferProvider, ORG_PROVIDERS } from '../src/sources/vendor'

it.each([
  ['glm-4.6', 'zai'],
  ['GLM-5.3', 'zai'],
  ['chatglm3', 'zai'],
  ['deepseek-v4-pro', 'deepseek'],
  ['qwen3-coder-plus', 'alibaba'],
  ['qwq-32b', 'alibaba'],
  ['kimi-k2.5', 'moonshotai'],
  ['k3.1-pro', 'moonshotai'],
  ['k2', 'moonshotai'],
  ['kick-model', 'unknown'],
  ['minimax-m2.1', 'minimax'],
  ['abab6', 'minimax'],
  ['muse-spark-1.3', 'meta'],
  ['llama-3.3-70b', 'meta'],
  ['devstral-small', 'mistral'],
  ['gemma4:31b', 'google'],
  ['gemini-3-pro', 'google'],
  ['gpt-oss-120b', 'openai'],
  ['gpt-5', 'openai'],
  ['chatgpt-4o', 'openai'],
  ['o1', 'openai'],
  ['o3-mini', 'openai'],
  ['o4-mini', 'openai'],
  ['o10', 'unknown'],
  ['codex-mini', 'openai'],
  ['grok-4', 'xai'],
  ['deepseek/deepseek-chat', 'deepseek'],
  ['z-ai/glm-5', 'zai'],
  ['claude-opus-4-5', 'anthropic'],
  ['cc-claude-sonnet-4', 'anthropic'],
  ['mimo-v2.5', 'xiaomi'],
  ['step-3.7-flash', 'stepfun'],
  ['random', 'unknown'],
  ['constructor/random', 'unknown'],
  ['toString/gpt-5', 'openai'],
  ['gateway/deepseek-v4', 'deepseek'],
  ['gateway/nested/GLM-5', 'zai'],
  ['OPENAI/claude-test', 'openai'],
  ['meta-llama/anything', 'meta'],
  ['mistral-small', 'mistral'],
  ['codestral-latest', 'mistral'],
  ['magistral-medium', 'mistral'],
  ['ministral-8b', 'mistral'],
  ['mixtral-8x7b', 'mistral'],
  ['pixtral-12b', 'mistral'],
  ['', 'unknown'],
  ['glmish', 'unknown'],
  ['museful', 'unknown'],
])('infers %s as %s', (model, expected) => {
  // Given / When / Then
  expect(inferProvider(model)).toBe(expected)
})

it.each(
  Object.entries({
    anthropic: 'anthropic',
    openai: 'openai',
    google: 'google',
    'x-ai': 'xai',
    xai: 'xai',
    deepseek: 'deepseek',
    'deepseek-ai': 'deepseek',
    'z-ai': 'zai',
    zai: 'zai',
    qwen: 'alibaba',
    alibaba: 'alibaba',
    moonshotai: 'moonshotai',
    minimax: 'minimax',
    meta: 'meta',
    'meta-llama': 'meta',
    mistralai: 'mistral',
  }),
)('gives org %s precedence over a conflicting family', (org, provider) => {
  // Given / When / Then
  expect(ORG_PROVIDERS[org]).toBe(provider)
  expect(inferProvider(`${org}/nested/gpt-5`)).toBe(provider)
})
