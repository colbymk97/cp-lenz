export interface YoinkSettings {
  'yoink.embedding.provider': 'openai';
  'yoink.embedding.openai.model': string;
  'yoink.embedding.openai.baseUrl': string;
  'yoink.search.topK': number;
  'yoink.sync.onStartup': boolean;
  'yoink.log.level': 'debug' | 'info' | 'warn' | 'error';
}

export const SETTING_KEYS = {
  EMBEDDING_PROVIDER: 'yoink.embedding.provider',
  OPENAI_MODEL: 'yoink.embedding.openai.model',
  OPENAI_BASE_URL: 'yoink.embedding.openai.baseUrl',
  SEARCH_TOP_K: 'yoink.search.topK',
  SYNC_ON_STARTUP: 'yoink.sync.onStartup',
  LOG_LEVEL: 'yoink.log.level',
} as const;
