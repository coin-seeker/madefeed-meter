export const ORG_PROVIDERS: Readonly<Record<string, string>> = {
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
}

const families: readonly (readonly [RegExp, string])[] = [
  [/^(claude-|cc-claude-)/, 'anthropic'],
  [/^(gpt-oss|gpt-|chatgpt-|o[134](-|$)|codex-)/, 'openai'],
  [/^(gemini-|gemma)/, 'google'],
  [/^grok-/, 'xai'],
  [/^deepseek/, 'deepseek'],
  [/^(glm-|chatglm)/, 'zai'],
  [/^(qwen|qwq)/, 'alibaba'],
  [/^(kimi|k\d+(\.\d+)?(-|$))/, 'moonshotai'],
  [/^(minimax|abab)/, 'minimax'],
  [/^(muse-|llama)/, 'meta'],
  [
    /^(mistral|devstral|codestral|magistral|ministral|mixtral|pixtral)/,
    'mistral',
  ],
  [/^mimo/, 'xiaomi'],
  [/^step-/, 'stepfun'],
]

export function inferProvider(model: string): string {
  const segments = model.toLowerCase().split('/')
  const first = segments[0] ?? ''
  const org =
    segments.length > 1 && Object.hasOwn(ORG_PROVIDERS, first)
      ? ORG_PROVIDERS[first]
      : undefined
  return (
    org ??
    families.find(([pattern]) => pattern.test(segments.at(-1) ?? ''))?.[1] ??
    'unknown'
  )
}
