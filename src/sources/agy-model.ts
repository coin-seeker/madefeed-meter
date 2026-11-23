export function antigravityModels() {
  const ids: Readonly<Record<number, string>> = {
    246: 'gemini-2.5-pro',
    312: 'gemini-2.5-flash',
    313: 'gemini-2.5-flash-thinking',
    329: 'gemini-2.5-flash-thinking',
    330: 'gemini-2.5-flash-lite',
    281: 'claude-sonnet-4',
    282: 'claude-sonnet-4',
    290: 'claude-opus-4',
    291: 'claude-opus-4',
    333: 'claude-4.5-sonnet',
    334: 'claude-4.5-sonnet',
    340: 'claude-4.5-haiku',
    341: 'claude-4.5-haiku',
    342: 'model_openai_gpt_oss_120b_medium',
  }
  const aliases: Readonly<Record<string, string>> = {
    'gemini 3.8 flash': 'gemini-3.8-flash',
    'gemini 3.8 flash thinking': 'gemini-3.8-flash',
    'gemini 3.7 flash': 'gemini-3.7-flash',
    'gemini 3.7 flash thinking': 'gemini-3.7-flash',
    'gemini 3.7 pro': 'gemini-3.7-pro',
    'gemini 3.7 pro thinking': 'gemini-3.7-pro',
    'gemini 3.6 flash': 'gemini-3.6-flash',
    'gemini 3 flash': 'gemini-3.6-flash',
    'gemini 3.6 pro': 'gemini-3.6-pro',
    'gemini 3 pro': 'gemini-3-pro',
    'gemini 3 pro thinking': 'gemini-3-pro',
    'gemini 2.5 flash': 'gemini-2.5-flash',
    'gemini 2.5 pro': 'gemini-2.5-pro',
    'gemini 2.0 flash': 'gemini-2.0-flash',
    'gemini 2 flash': 'gemini-2.0-flash',
    'gemini 2.0 pro': 'gemini-2.0-pro',
    'gemini 1.5 flash': 'gemini-1.5-flash',
    'gemini 1.5 pro': 'gemini-1.5-pro',
    model_placeholder_m318: 'gemini-3.8-flash-high',
    model_placeholder_m319: 'gemini-3.8-flash-medium',
    model_placeholder_m320: 'gemini-3.8-flash-low',
    model_placeholder_m298: 'gemini-3.7-flash-high',
    model_placeholder_m299: 'gemini-3.7-flash-medium',
    model_placeholder_m300: 'gemini-3.7-flash-low',
    model_placeholder_m71: 'gemini-3.6-flash-high',
    model_placeholder_m72: 'gemini-3.6-flash-medium',
    model_placeholder_m73: 'gemini-3.6-flash-low',
    model_placeholder_m417: 'gemini-4-argon',
    model_placeholder_m418: 'gemini-4-argon',
    model_placeholder_m419: 'gemini-4-argon',
    model_placeholder_m402: 'claude-opus-5-5',
    model_placeholder_m50: 'gemini-3.1-flash-lite',
    model_placeholder_m26: 'claude-opus-4-6',
    model_placeholder_m35: 'claude-sonnet-4-6',
    model_placeholder_m36: 'gemini-3.1-pro',
    model_placeholder_m37: 'gemini-3.1-pro',
    model_placeholder_m16: 'gemini-3.1-pro',
    model_placeholder_m18: 'gemini-3-flash-preview',
    model_placeholder_m84: 'gemini-3-flash-preview',
    model_placeholder_m47: 'gemini-3-flash-preview',
    model_placeholder_m132: 'gemini-3.5-flash-high',
    model_placeholder_m133: 'gemini-3.5-flash-high',
    model_placeholder_m187: 'gemini-3.5-flash-extra-low',
    model_placeholder_m20: 'gemini-3.5-flash-medium',
    model_openai_gpt_oss_120b_medium: 'gpt-oss-120b-medium',
    'gemini-pro-default': 'gemini-3.1-pro',
    'gemini-pro-agent': 'gemini-3.1-pro',
    'gemini-3-flash-agent': 'gemini-3.5-flash-high',
    'gemini-3-flash-agent-a': 'gemini-3.5-flash-high',
    'gemini-3-flash-agent-b': 'gemini-3.5-flash-high',
    'gemini-3-flash-a': 'gemini-3.5-flash-high',
    'gemini-3-flash-b': 'gemini-3.5-flash-high',
    'gemini-3-flash-c': 'gemini-3-flash-preview',
    'gemini-3-flash': 'gemini-3-flash-preview',
    'gemini-3.5-flash-low': 'gemini-3.5-flash-medium',
    'gemini-3.1-pro-high': 'gemini-3.1-pro',
    'gemini-3.1-pro-low': 'gemini-3.1-pro',
    'gemini-3-pro-high': 'gemini-3-pro',
    'gemini-3-pro-low': 'gemini-3-pro',
    'claude 3.7 sonnet': 'claude-3-7-sonnet',
    'claude 3.7 sonnet thinking': 'claude-3-7-sonnet',
    'claude 3.5 sonnet': 'claude-3-5-sonnet',
    'claude 3.5 haiku': 'claude-3-5-haiku',
    'claude 3 opus': 'claude-3-opus',
  }
  const normalize = (raw: string | undefined): string | undefined => {
    const trimmed = raw?.trim()
    if (!trimmed) return undefined
    const lower = trimmed.toLowerCase()
    const effort = /^(gemini 3\.[678] flash) \((high|medium|low)\)$/.exec(lower)
    if (effort?.[1] && effort[2])
      return `${effort[1].replaceAll(' ', '-')}-${effort[2]}`
    const base = lower.split('(')[0]?.trim() ?? lower
    const alias = aliases[base]
    if (alias) return alias
    const converted = base.replaceAll(' ', '-')
    return /^(gemini-|claude-|gpt-)/.test(converted) ? converted : trimmed
  }
  const nameFromId = (id: number) =>
    ids[id] ??
    (id >= 1000 ? `model_placeholder_m${id - 1000}` : `antigravity-model-${id}`)
  const fromId = (id: number | undefined, names: ReadonlyMap<number, string>) =>
    id === undefined ? undefined : normalize(names.get(id) ?? nameFromId(id))
  const rowModel = (
    text: string | undefined,
    id: number | undefined,
    names: ReadonlyMap<number, string>,
  ) => (text?.trim() ? text : fromId(id, names))
  const rank = (model: string | undefined) =>
    !model || model === 'gemini-internal-model'
      ? 0
      : /^(model_placeholder_m|antigravity-model-)/.test(model)
        ? 1
        : 2
  const resolve = (
    usageId: number | undefined,
    context: {
      readonly model: string | undefined
      readonly id: number | undefined
    },
    names: ReadonlyMap<number, string>,
  ) => {
    const byId = fromId(usageId, names)
    const ctx = normalize(context.model)
    return (
      (rank(byId) === 2 ? byId : undefined) ??
      (usageId === context.id && rank(ctx) === 2 ? ctx : undefined) ??
      byId ??
      ctx ??
      'gemini-internal-model'
    )
  }
  return { normalize, nameFromId, fromId, rowModel, rank, resolve }
}
