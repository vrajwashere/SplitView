/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelActionCreators, ChannelStore, MessageActions, MessageStore } from "@webpack/common";

import { logger } from "../logger";

const PAGE_SIZE = 50;
export const INITIAL_MESSAGE_COUNT = 50;

interface FetchMessagesOptions {
    channelId: string;
    before?: string;
    limit: number;
}

interface MessageActionsWithFetch {
    fetchMessages(options: FetchMessagesOptions): Promise<boolean> | boolean | undefined;
}

interface ChannelActionCreatorsWithPreload {
    preload(guildId: string, channelId: string): Promise<unknown> | unknown;
}

const messageActions = MessageActions as unknown as MessageActionsWithFetch;
const channelActions = ChannelActionCreators as unknown as ChannelActionCreatorsWithPreload;
const inFlightRequests = new Map<string, Promise<void>>();
const initialLoadRequests = new Map<string, Promise<void>>();
const liveSyncRequests = new Map<string, Promise<void>>();
const liveSyncTargets = new Map<string, string>();

function compareMessageIds(first: string, second: string): number {
    try {
        const firstId = BigInt(first);
        const secondId = BigInt(second);
        return firstId < secondId ? -1 : firstId > secondId ? 1 : 0;
    } catch {
        return first.localeCompare(second);
    }
}

async function requestMessages(options: FetchMessagesOptions): Promise<void> {
    const requestKey = `${options.channelId}:${options.before ?? "present"}`;
    const existingRequest = inFlightRequests.get(requestKey);
    if (existingRequest) return existingRequest;

    const request = Promise.resolve(messageActions.fetchMessages(options))
        .then(() => undefined)
        .catch(error => {
            logger.error("Failed to load messages", { channelId: options.channelId, error });
            throw error;
        })
        .finally(() => inFlightRequests.delete(requestKey));

    inFlightRequests.set(requestKey, request);
    return request;
}

export function ensureMessages(channelId: string): Promise<void> {
    const existingRequest = initialLoadRequests.get(channelId);
    if (existingRequest) return existingRequest;

    // Rapid tab remounts share the entire preload/history operation, not just
    // the individual HTTP requests inside it.
    const request = Promise.resolve()
        .then(() => loadInitialMessages(channelId))
        .finally(() => initialLoadRequests.delete(channelId));
    initialLoadRequests.set(channelId, request);
    return request;
}

async function loadInitialMessages(channelId: string): Promise<void> {
    const channel = ChannelStore.getChannel(channelId);
    if (channel?.guild_id) {
        // SplitView channels never become Discord's globally selected channel.
        // Repeat the native preload whenever their message cache needs recovery.
        try {
            await channelActions.preload(channel.guild_id, channelId);
        } catch (error) {
            logger.warn("Failed to preload live guild channel", { channelId, error });
        }
    }

    let messages = MessageStore.getMessages(channelId);

    // A channel can be marked ready with only a small partial cache. Fetch the
    // latest page first unless Discord has already completed that request.
    if (!messages.ready || !messages.hasFetched) {
        if (messages.loadingMore) return;
        await requestMessages({ channelId, limit: PAGE_SIZE });
        messages = MessageStore.getMessages(channelId);
    }

    // Fill a newly opened pane to a useful initial history window. The progress
    // guard prevents a retry loop if Discord returns no additional records.
    while (messages._array.length < INITIAL_MESSAGE_COUNT && messages.hasMoreBefore) {
        const before = messages._array[0]?.id;
        if (!before || messages.loadingMore) return;

        const previousCount = messages._array.length;
        await requestMessages({ channelId, before, limit: PAGE_SIZE });
        messages = MessageStore.getMessages(channelId);
        if (messages._array.length <= previousCount) return;
    }
}

export function fetchOlderMessages(channelId: string): Promise<void> {
    const messages = MessageStore.getMessages(channelId);
    const before = messages._array[0]?.id;
    if (!before || !messages.hasMoreBefore || messages.loadingMore) return Promise.resolve();
    return requestMessages({ channelId, before, limit: PAGE_SIZE });
}

async function syncLiveTarget(channelId: string, lastMessageId: string): Promise<void> {
    const messages = MessageStore.getMessages(channelId);
    const cachedLastMessageId = messages._array.at(-1)?.id;
    if (
        messages.ready
        && !messages.hasMoreAfter
        && (MessageStore.getMessage(channelId, lastMessageId)
            || cachedLastMessageId != null && compareMessageIds(cachedLastMessageId, lastMessageId) >= 0)
    ) return;

    logger.warn("Repairing split channel cache that left the live edge", {
        channelId,
        observedLastMessageId: lastMessageId,
        cachedLastMessageId,
        ready: messages.ready,
        hasMoreAfter: messages.hasMoreAfter,
        containsObservedMessage: Boolean(MessageStore.getMessage(channelId, lastMessageId))
    });

    // A present-page fetch resets ready/hasMoreAfter and replaces any jumped or
    // truncated range with Discord's current live edge. Replaying individual
    // MESSAGE_CREATE events is insufficient: ChannelMessages.receiveMessage()
    // deliberately discards them while hasMoreAfter is true.
    await requestMessages({ channelId, limit: PAGE_SIZE });
}

/** Reconcile a visible pane with the latest message ID observed by read state. */
export function syncLiveMessages(channelId: string, lastMessageId: string): Promise<void> {
    const queuedTarget = liveSyncTargets.get(channelId);
    if (!queuedTarget || compareMessageIds(queuedTarget, lastMessageId) < 0) {
        liveSyncTargets.set(channelId, lastMessageId);
    }

    const existingRequest = liveSyncRequests.get(channelId);
    if (existingRequest) return existingRequest;

    const request = (async () => {
        let target: string | undefined;
        while ((target = liveSyncTargets.get(channelId))) {
            liveSyncTargets.delete(channelId);
            await syncLiveTarget(channelId, target);
        }
    })().finally(() => liveSyncRequests.delete(channelId));

    liveSyncRequests.set(channelId, request);
    return request;
}
