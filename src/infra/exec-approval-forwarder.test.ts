import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createExecApprovalForwarder } from "./exec-approval-forwarder.js";

const baseRequest = {
  id: "req-1",
  request: {
    command: "echo hello",
    agentId: "main",
    sessionKey: "agent:main:main",
  },
  createdAtMs: 1000,
  expiresAtMs: 6000,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("exec approval forwarder", () => {
  it("forwards to session target and resolves", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: { exec: { enabled: true, mode: "session" } },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    // Verify channelData contains pre-built Discord embeds and components
    const requestPayloads = deliver.mock.calls[0][0].payloads;
    expect(requestPayloads[0].channelData).toBeDefined();
    expect(requestPayloads[0].channelData.discord.embeds).toBeInstanceOf(Array);
    expect(requestPayloads[0].channelData.discord.embeds.length).toBe(1);
    expect(requestPayloads[0].channelData.discord.components).toBeInstanceOf(Array);
    expect(requestPayloads[0].channelData.discord.components.length).toBe(1);

    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "slack:U1",
      ts: 2000,
    });
    // Non-Discord target still gets a text message on resolve
    expect(deliver).toHaveBeenCalledTimes(2);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("forwards to explicit targets and expires", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("edits Discord embed on resolve instead of sending new message", async () => {
    vi.useFakeTimers();
    const deliver = vi
      .fn()
      .mockResolvedValue([{ channel: "discord", messageId: "msg-1", channelId: "ch-1" }]);
    const editDiscordEmbed = vi.fn().mockResolvedValue(undefined);
    const cfg = {
      approvals: { exec: { enabled: true, mode: "session" } },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "discord", to: "channel:ch-1" }),
      editDiscordEmbed,
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "sPOONY",
      ts: 2000,
    });

    // Discord embed edited in place, no new message sent
    expect(editDiscordEmbed).toHaveBeenCalledTimes(1);
    expect(editDiscordEmbed.mock.calls[0][0]).toMatchObject({
      channelId: "ch-1",
      messageId: "msg-1",
    });
    // The edited embed should have green color (allow-once)
    const embed = editDiscordEmbed.mock.calls[0][0].embed;
    expect(embed.color).toBe(0x57f287);
    expect(embed.footer.text).toContain("Approved allow-once by sPOONY");

    // No additional deliver call for Discord targets
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
  });

  it("edits Discord embed on expire", async () => {
    vi.useFakeTimers();
    const deliver = vi
      .fn()
      .mockResolvedValue([{ channel: "discord", messageId: "msg-2", channelId: "ch-2" }]);
    const editDiscordEmbed = vi.fn().mockResolvedValue(undefined);
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "discord", to: "channel:ch-2" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
      editDiscordEmbed,
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();

    // Discord embed edited to expired state
    expect(editDiscordEmbed).toHaveBeenCalledTimes(1);
    const embed = editDiscordEmbed.mock.calls[0][0].embed;
    expect(embed.color).toBe(0x99aab5); // Gray
    expect(embed.footer.text).toContain("Expired");

    // No separate text message sent to Discord target
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("sends text to non-Discord and edits Discord on mixed targets", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockImplementation(async (params) => {
      if (params.channel === "discord") {
        return [{ channel: "discord", messageId: "msg-3", channelId: "ch-3" }];
      }
      return [];
    });
    const editDiscordEmbed = vi.fn().mockResolvedValue(undefined);
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [
            { channel: "discord", to: "channel:ch-3" },
            { channel: "telegram", to: "123" },
          ],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
      editDiscordEmbed,
    });

    await forwarder.handleRequested(baseRequest);
    // Initial delivery to both targets
    expect(deliver).toHaveBeenCalledTimes(2);

    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "deny",
      resolvedBy: "admin",
      ts: 2000,
    });

    // Discord embed edited
    expect(editDiscordEmbed).toHaveBeenCalledTimes(1);
    const embed = editDiscordEmbed.mock.calls[0][0].embed;
    expect(embed.color).toBe(0xed4245); // Red for deny
    expect(embed.footer.text).toContain("Denied by admin");

    // Text message sent to telegram only
    expect(deliver).toHaveBeenCalledTimes(3);
    const lastCall = deliver.mock.calls[2][0];
    expect(lastCall.channel).toBe("telegram");

    await vi.runAllTimersAsync();
  });
});
