/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const MAXIMUM_CACHED_VIEWPORTS = 32;

export interface MessageViewportState {
    compact: boolean;
    height: number;
    messageOffsetTop: number;
    rowHeights: Map<string, number>;
    scrollTop: number;
    stickToBottom: boolean;
    visibleLimit: number;
}

const messageViewportStates = new Map<string, MessageViewportState>();

export function getMessageViewportState(viewportKey: string): MessageViewportState | undefined {
    const viewport = messageViewportStates.get(viewportKey);
    if (!viewport) return;

    // Refresh insertion order so active tabs remain in the bounded cache.
    messageViewportStates.delete(viewportKey);
    messageViewportStates.set(viewportKey, viewport);
    return viewport;
}

export function rememberMessageViewportState(viewportKey: string, viewport: MessageViewportState): void {
    messageViewportStates.delete(viewportKey);
    messageViewportStates.set(viewportKey, viewport);

    while (messageViewportStates.size > MAXIMUM_CACHED_VIEWPORTS) {
        const oldestKey = messageViewportStates.keys().next().value;
        if (oldestKey == null) break;
        messageViewportStates.delete(oldestKey);
    }
}

export function forgetMessageViewportState(viewportKey: string): void {
    messageViewportStates.delete(viewportKey);
}

export function clearMessageViewportStates(): void {
    messageViewportStates.clear();
}
