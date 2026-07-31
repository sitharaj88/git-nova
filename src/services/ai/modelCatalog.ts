import { AiModelInfo, ProviderId } from './types';

/**
 * Static curated model lists per provider — a sensible starting set shown in
 * the model picker even before (or without) a live listing. Live listings
 * from each adapter's listModels() are merged on top when available.
 */
export const STATIC_MODELS: Record<Exclude<ProviderId, 'vscode'>, AiModelInfo[]> = {
  anthropic: [
    { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', source: 'static' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', source: 'static' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', source: 'static' },
  ],
  openai: [
    { id: 'gpt-5.2', label: 'GPT-5.2', provider: 'openai', source: 'static' },
    { id: 'gpt-5.2-mini', label: 'GPT-5.2 mini', provider: 'openai', source: 'static' },
    { id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai', source: 'static' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'openai', source: 'static' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'gemini', source: 'static' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'gemini', source: 'static' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', provider: 'gemini', source: 'static' },
  ],
  'openai-compatible': [],
};

export interface CompatiblePreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Suggested model ids to prefill the picker with. */
  models: string[];
  /** Whether GET {baseUrl}/models works for live listing. */
  supportsModelList: boolean;
}

/**
 * One-click presets for the OpenAI-compatible provider. Selecting one in the
 * model picker fills gitNova.ai.baseUrl and suggests model ids.
 */
export const COMPATIBLE_PRESETS: CompatiblePreset[] = [
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.3', 'qwen2.5-coder', 'deepseek-r1', 'mistral'],
    supportsModelList: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    models: [],
    supportsModelList: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    supportsModelList: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-5', 'openai/gpt-5.2', 'google/gemini-2.5-pro'],
    supportsModelList: true,
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'codestral-latest'],
    supportsModelList: true,
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3-mini'],
    supportsModelList: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    supportsModelList: true,
  },
  {
    id: 'glm',
    label: 'Zhipu GLM (Z.ai)',
    // International endpoint; mainland China users can pick "Custom endpoint"
    // and enter https://open.bigmodel.cn/api/paas/v4 instead.
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air'],
    supportsModelList: true,
  },
  {
    id: 'custom',
    label: 'Custom endpoint…',
    baseUrl: '',
    models: [],
    supportsModelList: true,
  },
];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  vscode: 'VS Code Language Model (Copilot)',
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  'openai-compatible': 'OpenAI-compatible (Ollama, Groq, OpenRouter, …)',
};

/** Default model per provider when the user hasn't picked one yet. */
export const DEFAULT_MODELS: Record<Exclude<ProviderId, 'vscode'>, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.2-mini',
  gemini: 'gemini-2.5-flash',
  'openai-compatible': 'gpt-4o-mini',
};
