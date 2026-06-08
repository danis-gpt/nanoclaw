export type ArchivePlatform = 'telegram' | 'whatsapp';

export interface ArchivedMessage {
  platform: ArchivePlatform;
  chat_jid: string;
  chat_title: string | null;
  message_id: string;
  timestamp: string; // ISO 8601 UTC
  sender_id: string | null;
  sender_name: string | null;
  text: string;
  reply_to: string | null;
  media_type: string | null;
  media_ref: string | null;
  raw_source_ref: string; // stable dedup key: `<platform>:<chat_jid>:<message_id>`
  import_batch_id: string;
  is_from_me: boolean;
}

export interface RawTelegramMessage {
  id?: number | string;
  type?: string;
  date?: string;
  date_unixtime?: string | number;
  from?: string;
  from_id?: string;
  actor?: string;
  actor_id?: string;
  text?: string | Array<string | { type?: string; text?: string }>;
  text_entities?: Array<{ type?: string; text?: string }>;
  reply_to_message_id?: number | string;
  media_type?: string;
  photo?: string;
  file?: string;
  file_name?: string;
  sticker_emoji?: string;
}

export interface RawTelegramChat {
  name?: string | null;
  type?: string;
  id?: number | string;
  messages?: RawTelegramMessage[];
}

export interface RawWhatsAppMessage {
  from_me?: boolean;
  timestamp?: number;
  time?: string;
  media?: boolean;
  key_id?: string;
  meta?: boolean;
  data?: string | null;
  sender?: string | null;
  mime?: string | null;
  message_type?: number;
  received_timestamp?: string | null;
  reply?: string | null;
  quoted_data?: string | null;
  caption?: string | null;
}

export interface RawWhatsAppChat {
  name?: string | null;
  type?: string | null;
  messages?: Record<string, RawWhatsAppMessage>;
}

export interface ImportBatch {
  id: string;
  platform: ArchivePlatform;
  source_path: string;
  started_at: string;
  finished_at: string | null;
  messages_seen: number;
  messages_inserted: number;
  messages_skipped: number;
  status: 'running' | 'completed' | 'failed';
  error: string | null;
}

export interface ChunkRef {
  id: number;
  platform: ArchivePlatform;
  chat_jid: string;
  chat_title: string | null;
  month: string; // YYYY-MM
  path: string; // relative to DATA_DIR/archive
  message_count: number;
  min_timestamp: string;
  max_timestamp: string;
  wiki_ingested_at: string | null;
}

export interface ImporterProgress {
  seen: number;
  inserted: number;
  skipped: number;
  chats: number;
  lastTimestamp?: string;
}
