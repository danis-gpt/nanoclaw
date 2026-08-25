/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { getDb } from '../db/connection.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';

const TELEGRAM_CHANNEL_TYPE = 'telegram';
const DEFAULT_BOT_ALIAS = 'default';

const TELEGRAM_DEFAULTS: ChannelDefaults = {
  dm: {
    engageMode: 'pattern',
    engagePattern: '.',
    threads: false,
    unknownSenderPolicy: 'request_approval',
  },
  group: {
    engageMode: 'mention-sticky',
    threads: true,
    unknownSenderPolicy: 'request_approval',
  },
  mentions: 'platform',
};

const TELEGRAM_BOT_CONFIGS = [
  { alias: DEFAULT_BOT_ALIAS, envKey: 'TELEGRAM_BOT_TOKEN', legacyEnvKey: undefined },
  { alias: 'aura', envKey: 'TELEGRAM_BOT_TOKEN_AURA', legacyEnvKey: 'TELEGRAM_BOT_TOKEN_AURA_2' },
  { alias: 'radar', envKey: 'TELEGRAM_BOT_TOKEN_RADAR', legacyEnvKey: undefined },
  { alias: 'vektor', envKey: 'TELEGRAM_BOT_TOKEN_VEKTOR', legacyEnvKey: undefined },
] as const;

type TelegramBotAlias = (typeof TELEGRAM_BOT_CONFIGS)[number]['alias'];

interface TelegramBotConfig {
  alias: TelegramBotAlias;
  envKey: string;
  legacyEnvKey?: string;
  token: string;
}

interface TelegramBotBridge {
  alias: TelegramBotAlias;
  envKey: string;
  token: string;
  bridge: ChannelAdapter;
  botUsernamePromise: Promise<string | null>;
}

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
      // eslint-disable-next-line no-catch-all/no-catch-all -- the channel boundary handles and reports this failure
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- the channel boundary handles and reports this failure
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

function isScopedDmPlatformId(platformId: string, aliases: Set<TelegramBotAlias>): boolean {
  const parts = platformId.split(':');
  return parts.length >= 3 && parts[0] === TELEGRAM_CHANNEL_TYPE && aliases.has(parts[1] as TelegramBotAlias);
}

function scopeInboundPlatformId(alias: TelegramBotAlias, platformId: string): string {
  if (alias === DEFAULT_BOT_ALIAS || isGroupPlatformId(platformId)) return platformId;
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId || isScopedDmPlatformId(platformId, new Set(TELEGRAM_BOT_CONFIGS.map((c) => c.alias)))) return platformId;
  return `${TELEGRAM_CHANNEL_TYPE}:${alias}:${chatId}`;
}

function rawTelegramPlatformId(platformId: string, aliases: Set<TelegramBotAlias>): string {
  const parts = platformId.split(':');
  if (parts.length >= 3 && parts[0] === TELEGRAM_CHANNEL_TYPE && aliases.has(parts[1] as TelegramBotAlias)) {
    return `${TELEGRAM_CHANNEL_TYPE}:${parts.slice(2).join(':')}`;
  }
  return platformId;
}

function aliasFromScopedPlatformId(platformId: string, aliases: Set<TelegramBotAlias>): TelegramBotAlias | null {
  const parts = platformId.split(':');
  if (parts.length >= 3 && parts[0] === TELEGRAM_CHANNEL_TYPE && aliases.has(parts[1] as TelegramBotAlias)) {
    return parts[1] as TelegramBotAlias;
  }
  return null;
}

function resolveBotAliasForPlatformId(
  platformId: string,
  availableAliases: Set<TelegramBotAlias>,
): TelegramBotAlias | null {
  const scopedAlias = aliasFromScopedPlatformId(platformId, availableAliases);
  if (scopedAlias) return scopedAlias;

  const rows = getDb()
    .prepare(
      `SELECT ag.folder
         FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
         JOIN agent_groups ag ON ag.id = mga.agent_group_id
        WHERE mg.channel_type = ? AND mg.platform_id = ?
     ORDER BY mga.priority DESC, ag.folder ASC`,
    )
    .all(TELEGRAM_CHANNEL_TYPE, platformId) as Array<{ folder: string }>;

  for (const row of rows) {
    if (availableAliases.has(row.folder as TelegramBotAlias)) return row.folder as TelegramBotAlias;
  }
  return null;
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

/**
 * Build an onInbound interceptor that consumes pairing codes before they
 * reach the router. On match: records the chat + its paired user, promotes
 * the user to owner if the instance has no owner yet, and short-circuits.
 * On miss: forwards to the host.
 */
/**
 * Send a one-shot confirmation back to the paired chat. Best-effort — failures
 * are logged but never propagated, so a Telegram outage can't undo a successful
 * pairing or trigger the interceptor's fail-open path.
 */
async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Pairing success! Head back to the NanoClaw installer to finish setup.',
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- the channel boundary handles and reports this failure
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
  mapPlatformId: (platformId: string) => string = (platformId) => platformId,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    const rawPlatformId = platformId;
    const effectivePlatformId = mapPlatformId(platformId);
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(effectivePlatformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(effectivePlatformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId: effectivePlatformId,
        isGroup: isGroupPlatformId(rawPlatformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(effectivePlatformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const existing = getMessagingGroupByPlatform(TELEGRAM_CHANNEL_TYPE, effectivePlatformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: TELEGRAM_CHANNEL_TYPE,
          platform_id: effectivePlatformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId: effectivePlatformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, rawPlatformId);
      // eslint-disable-next-line no-catch-all/no-catch-all -- the channel boundary handles and reports this failure
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      hostOnInbound(effectivePlatformId, threadId, message);
    }
  };
}

function createSingleTelegramBridge(config: TelegramBotConfig): TelegramBotBridge {
  const telegramAdapter = createTelegramAdapter({
    botToken: config.token,
    mode: 'polling',
  });
  const bridge = createChatSdkBridge({
    adapter: telegramAdapter,
    concurrency: 'concurrent',
    extractReplyContext,
    supportsThreads: true,
    defaults: TELEGRAM_DEFAULTS,
    transformOutboundText: sanitizeTelegramLegacyMarkdown,
    maxTextLength: 4000,
  });

  return {
    alias: config.alias,
    envKey: config.envKey,
    token: config.token,
    bridge,
    botUsernamePromise: fetchBotUsername(config.token),
  };
}

function createTelegramMultiplexer(botConfigs: TelegramBotConfig[]): ChannelAdapter {
  const bridges = botConfigs.map(createSingleTelegramBridge);
  const byAlias = new Map<TelegramBotAlias, TelegramBotBridge>(bridges.map((bridge) => [bridge.alias, bridge]));
  const availableAliases = new Set<TelegramBotAlias>(byAlias.keys());
  const defaultBridge = byAlias.get(DEFAULT_BOT_ALIAS) ?? bridges[0]!;

  function resolveBridge(platformId: string): TelegramBotBridge {
    const alias = resolveBotAliasForPlatformId(platformId, availableAliases);
    if (alias) return byAlias.get(alias)!;

    const allKnownAliases = new Set<TelegramBotAlias>(TELEGRAM_BOT_CONFIGS.map((c) => c.alias));
    const configuredAgentAlias = resolveBotAliasForPlatformId(platformId, allKnownAliases);
    if (configuredAgentAlias && configuredAgentAlias !== DEFAULT_BOT_ALIAS) {
      throw new Error(
        `Telegram bot token missing for agent folder ${configuredAgentAlias}; refusing to send via default bot`,
      );
    }

    return defaultBridge;
  }

  const multiplexer: ChannelAdapter = {
    ...defaultBridge.bridge,
    name: TELEGRAM_CHANNEL_TYPE,
    channelType: TELEGRAM_CHANNEL_TYPE,
    supportsThreads: true,
    defaults: TELEGRAM_DEFAULTS,

    async setup(hostConfig: ChannelSetup) {
      for (const bridge of bridges) {
        const intercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createPairingInterceptor(
            bridge.botUsernamePromise,
            hostConfig.onInbound,
            bridge.token,
            (platformId) => scopeInboundPlatformId(bridge.alias, platformId),
          ),
        };
        await withRetry(() => bridge.bridge.setup(intercepted), `${bridge.alias}.bridge.setup`);
        log.info('Telegram bot bridge started', { alias: bridge.alias, envKey: bridge.envKey });
      }
    },

    async teardown() {
      for (const bridge of bridges) {
        await bridge.bridge.teardown();
      }
    },

    isConnected() {
      return bridges.every((bridge) => bridge.bridge.isConnected());
    },

    async deliver(platformId, threadId, message) {
      const bridge = resolveBridge(platformId);
      return bridge.bridge.deliver(rawTelegramPlatformId(platformId, availableAliases), threadId, message);
    },

    async setTyping(platformId, threadId) {
      const bridge = resolveBridge(platformId);
      await bridge.bridge.setTyping?.(rawTelegramPlatformId(platformId, availableAliases), threadId);
    },

    async resolveChannelName(platformId: string) {
      const bridge = resolveBridge(platformId);
      const rawPlatformId = rawTelegramPlatformId(platformId, availableAliases);
      const chatId = rawPlatformId.split(':').slice(1).join(':');
      if (!chatId) return null;
      try {
        const res = await fetch(`https://api.telegram.org/bot${bridge.token}/getChat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId }),
        });
        const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
        return data.ok ? (data.result?.title ?? null) : null;
        // eslint-disable-next-line no-catch-all/no-catch-all -- the channel boundary handles and reports this failure
      } catch {
        return null;
      }
    },

    async subscribe(platformId, threadId) {
      const bridge = resolveBridge(platformId);
      await bridge.bridge.subscribe?.(rawTelegramPlatformId(platformId, availableAliases), threadId);
    },
  };

  if (defaultBridge.bridge.openDM) {
    multiplexer.openDM = (userHandle: string) => defaultBridge.bridge.openDM!(userHandle);
  }

  return multiplexer;
}

registerChannelAdapter('telegram', {
  defaults: TELEGRAM_DEFAULTS,
  factory: () => {
    const env = readEnvFile(TELEGRAM_BOT_CONFIGS.flatMap((config) => [config.envKey, config.legacyEnvKey ?? '']));
    const botConfigs = TELEGRAM_BOT_CONFIGS.flatMap((config): TelegramBotConfig[] => {
      const token = env[config.envKey] || (config.legacyEnvKey ? env[config.legacyEnvKey] : undefined);
      return token ? [{ ...config, token }] : [];
    });
    if (botConfigs.length === 0) return null;
    return createTelegramMultiplexer(botConfigs);
  },
});
