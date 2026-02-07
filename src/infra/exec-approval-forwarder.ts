import type { OpenClawConfig } from "../config/config.js";
import type {
  ExecApprovalForwardingConfig,
  ExecApprovalForwardTarget,
} from "../config/types.approvals.js";
import type { ExecApprovalDecision } from "./exec-approvals.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import {
  buildExecApprovalComponents,
  formatExecApprovalEmbed,
  formatExpiredEmbed,
  formatResolvedEmbed,
} from "../discord/monitor/exec-approvals.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { resolveSessionDeliveryTarget } from "./outbound/targets.js";

const log = createSubsystemLogger("gateway/exec-approvals");

export type ExecApprovalRequest = {
  id: string;
  request: {
    command: string;
    cwd?: string | null;
    host?: string | null;
    security?: string | null;
    ask?: string | null;
    agentId?: string | null;
    resolvedPath?: string | null;
    sessionKey?: string | null;
  };
  createdAtMs: number;
  expiresAtMs: number;
};

export type ExecApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
};

type ForwardTarget = ExecApprovalForwardTarget & { source: "session" | "target" };

type DiscordMessageRef = {
  channelId: string;
  messageId: string;
  accountId?: string;
};

type PendingApproval = {
  request: ExecApprovalRequest;
  targets: ForwardTarget[];
  timeoutId: NodeJS.Timeout | null;
  discordMessages: DiscordMessageRef[];
};

export type ExecApprovalForwarder = {
  handleRequested: (request: ExecApprovalRequest) => Promise<void>;
  handleResolved: (resolved: ExecApprovalResolved) => Promise<void>;
  stop: () => void;
};

export type EditDiscordEmbedParams = {
  cfg: OpenClawConfig;
  channelId: string;
  messageId: string;
  embed: Record<string, unknown>;
  accountId?: string;
};

export type ExecApprovalForwarderDeps = {
  getConfig?: () => OpenClawConfig;
  deliver?: typeof deliverOutboundPayloads;
  nowMs?: () => number;
  resolveSessionTarget?: (params: {
    cfg: OpenClawConfig;
    request: ExecApprovalRequest;
  }) => ExecApprovalForwardTarget | null;
  editDiscordEmbed?: (params: EditDiscordEmbedParams) => Promise<void>;
};

const DEFAULT_MODE = "session" as const;

function normalizeMode(mode?: ExecApprovalForwardingConfig["mode"]) {
  return mode ?? DEFAULT_MODE;
}

function matchSessionFilter(sessionKey: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return sessionKey.includes(pattern) || new RegExp(pattern).test(sessionKey);
    } catch {
      return sessionKey.includes(pattern);
    }
  });
}

function shouldForward(params: {
  config?: ExecApprovalForwardingConfig;
  request: ExecApprovalRequest;
}): boolean {
  const config = params.config;
  if (!config?.enabled) {
    return false;
  }
  if (config.agentFilter?.length) {
    const agentId =
      params.request.request.agentId ??
      parseAgentSessionKey(params.request.request.sessionKey)?.agentId;
    if (!agentId) {
      return false;
    }
    if (!config.agentFilter.includes(agentId)) {
      return false;
    }
  }
  if (config.sessionFilter?.length) {
    const sessionKey = params.request.request.sessionKey;
    if (!sessionKey) {
      return false;
    }
    if (!matchSessionFilter(sessionKey, config.sessionFilter)) {
      return false;
    }
  }
  return true;
}

function buildTargetKey(target: ExecApprovalForwardTarget): string {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  const accountId = target.accountId ?? "";
  const threadId = target.threadId ?? "";
  return [channel, target.to, accountId, threadId].join(":");
}

function buildRequestMessage(request: ExecApprovalRequest, nowMs: number) {
  const lines: string[] = ["🔒 Exec approval required", `ID: ${request.id}`];
  lines.push(`Command: ${request.request.command}`);
  if (request.request.cwd) {
    lines.push(`CWD: ${request.request.cwd}`);
  }
  if (request.request.host) {
    lines.push(`Host: ${request.request.host}`);
  }
  if (request.request.agentId) {
    lines.push(`Agent: ${request.request.agentId}`);
  }
  if (request.request.security) {
    lines.push(`Security: ${request.request.security}`);
  }
  if (request.request.ask) {
    lines.push(`Ask: ${request.request.ask}`);
  }
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  lines.push(`Expires in: ${expiresIn}s`);
  lines.push("Reply with: /approve <id> allow-once|allow-always|deny");
  return lines.join("\n");
}

function decisionLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "allowed always";
  }
  return "denied";
}

function buildResolvedMessage(resolved: ExecApprovalResolved) {
  const base = `✅ Exec approval ${decisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

function buildExpiredMessage(request: ExecApprovalRequest) {
  return `⏱️ Exec approval expired. ID: ${request.id}`;
}

function defaultResolveSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): ExecApprovalForwardTarget | null {
  const sessionKey = params.request.request.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? params.request.request.agentId ?? "main";
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return null;
  }
  const target = resolveSessionDeliveryTarget({ entry, requestedChannel: "last" });
  if (!target.channel || !target.to) {
    return null;
  }
  if (!isDeliverableMessageChannel(target.channel)) {
    return null;
  }
  return {
    channel: target.channel,
    to: target.to,
    accountId: target.accountId,
    threadId: target.threadId,
  };
}

async function defaultEditDiscordEmbed(params: EditDiscordEmbedParams): Promise<void> {
  const { createDiscordClient } = await import("../discord/send.shared.js");
  const { Routes } = await import("discord-api-types/v10");
  const { rest, request } = createDiscordClient({ accountId: params.accountId }, params.cfg);
  await request(
    () =>
      rest.patch(Routes.channelMessage(params.channelId, params.messageId), {
        body: { content: "", embeds: [params.embed], components: [] },
      }),
    "edit-approval",
  );
}

/** Deliver to targets and return Discord message refs for later editing. */
async function deliverToTargets(params: {
  cfg: OpenClawConfig;
  targets: ForwardTarget[];
  text: string;
  channelData?: Record<string, unknown>;
  deliver: typeof deliverOutboundPayloads;
  shouldSend?: () => boolean;
}): Promise<DiscordMessageRef[]> {
  const discordMessages: DiscordMessageRef[] = [];
  const deliveries = params.targets.map(async (target) => {
    if (params.shouldSend && !params.shouldSend()) {
      return;
    }
    const channel = normalizeMessageChannel(target.channel) ?? target.channel;
    if (!isDeliverableMessageChannel(channel)) {
      return;
    }
    try {
      const results = await params.deliver({
        cfg: params.cfg,
        channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [{ text: params.text, channelData: params.channelData }],
      });
      // Track Discord message IDs for later editing
      if (channel === "discord") {
        for (const r of results) {
          if (r.messageId && r.messageId !== "unknown") {
            discordMessages.push({
              channelId: r.channelId ?? String(r.chatId ?? ""),
              messageId: r.messageId,
              accountId: target.accountId,
            });
          }
        }
      }
    } catch (err) {
      log.error(`exec approvals: failed to deliver to ${channel}:${target.to}: ${String(err)}`);
    }
  });
  await Promise.allSettled(deliveries);
  return discordMessages;
}

/** Edit tracked Discord embeds, send text to non-Discord targets. */
async function updateTargets(params: {
  cfg: OpenClawConfig;
  entry: PendingApproval;
  embed: Record<string, unknown>;
  text: string;
  deliver: typeof deliverOutboundPayloads;
  editDiscordEmbed: (params: EditDiscordEmbedParams) => Promise<void>;
}) {
  const { cfg, entry, embed, text, deliver, editDiscordEmbed } = params;

  // Edit Discord embeds in place
  if (entry.discordMessages.length > 0) {
    const edits = entry.discordMessages.map(async (msg) => {
      try {
        await editDiscordEmbed({ cfg, ...msg, embed });
      } catch (err) {
        log.error(`exec approvals: failed to edit discord message: ${String(err)}`);
      }
    });
    await Promise.allSettled(edits);
  }

  // Send text message to non-Discord targets
  const nonDiscordTargets = entry.targets.filter((t) => {
    const ch = normalizeMessageChannel(t.channel) ?? t.channel;
    return ch !== "discord";
  });
  if (nonDiscordTargets.length > 0) {
    await deliverToTargets({ cfg, targets: nonDiscordTargets, text, deliver });
  }
}

export function createExecApprovalForwarder(
  deps: ExecApprovalForwarderDeps = {},
): ExecApprovalForwarder {
  const getConfig = deps.getConfig ?? loadConfig;
  const deliver = deps.deliver ?? deliverOutboundPayloads;
  const nowMs = deps.nowMs ?? Date.now;
  const resolveSessionTarget = deps.resolveSessionTarget ?? defaultResolveSessionTarget;
  const editDiscordEmbed = deps.editDiscordEmbed ?? defaultEditDiscordEmbed;
  const pending = new Map<string, PendingApproval>();

  const handleRequested = async (request: ExecApprovalRequest) => {
    const cfg = getConfig();
    const config = cfg.approvals?.exec;
    if (!shouldForward({ config, request })) {
      return;
    }

    const mode = normalizeMode(config?.mode);
    const targets: ForwardTarget[] = [];
    const seen = new Set<string>();

    if (mode === "session" || mode === "both") {
      const sessionTarget = resolveSessionTarget({ cfg, request });
      if (sessionTarget) {
        const key = buildTargetKey(sessionTarget);
        if (!seen.has(key)) {
          seen.add(key);
          targets.push({ ...sessionTarget, source: "session" });
        }
      }
    }

    if (mode === "targets" || mode === "both") {
      const explicitTargets = config?.targets ?? [];
      for (const target of explicitTargets) {
        const key = buildTargetKey(target);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        targets.push({ ...target, source: "target" });
      }
    }

    if (targets.length === 0) {
      return;
    }

    const expiresInMs = Math.max(0, request.expiresAtMs - nowMs());
    const timeoutId = setTimeout(() => {
      void (async () => {
        const entry = pending.get(request.id);
        if (!entry) {
          return;
        }
        pending.delete(request.id);

        const cfg = getConfig();
        const embed = formatExpiredEmbed(request);
        const expiredText = buildExpiredMessage(request);
        await updateTargets({ cfg, entry, embed, text: expiredText, deliver, editDiscordEmbed });
      })();
    }, expiresInMs);
    timeoutId.unref?.();

    const pendingEntry: PendingApproval = {
      request,
      targets,
      timeoutId,
      discordMessages: [],
    };
    pending.set(request.id, pendingEntry);

    if (pending.get(request.id) !== pendingEntry) {
      return;
    }

    const text = buildRequestMessage(request, nowMs());
    const embed = formatExecApprovalEmbed(request);
    const components = buildExecApprovalComponents(request.id);
    const channelData: Record<string, unknown> = {
      discord: {
        embeds: [embed],
        components,
      },
    };
    const discordMessages = await deliverToTargets({
      cfg,
      targets,
      text,
      channelData,
      deliver,
      shouldSend: () => pending.get(request.id) === pendingEntry,
    });
    // Store Discord message refs for later editing
    pendingEntry.discordMessages = discordMessages;
  };

  const handleResolved = async (resolved: ExecApprovalResolved) => {
    const entry = pending.get(resolved.id);
    if (!entry) {
      return;
    }
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
    }
    pending.delete(resolved.id);

    const cfg = getConfig();
    const embed = formatResolvedEmbed(entry.request, resolved.decision, resolved.resolvedBy);
    const text = buildResolvedMessage(resolved);
    await updateTargets({ cfg, entry, embed, text, deliver, editDiscordEmbed });
  };

  const stop = () => {
    for (const entry of pending.values()) {
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
    }
    pending.clear();
  };

  return { handleRequested, handleResolved, stop };
}

export function shouldForwardExecApproval(params: {
  config?: ExecApprovalForwardingConfig;
  request: ExecApprovalRequest;
}): boolean {
  return shouldForward(params);
}
