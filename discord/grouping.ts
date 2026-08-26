/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, Message } from "@vencord/discord-types";
import { MessageTypeSets } from "@webpack/common";

const MESSAGE_GROUP_WINDOW_MS = 7 * 60 * 1000;

function isSameCalendarDay(first: Date, second: Date): boolean {
    return first.getFullYear() === second.getFullYear()
        && first.getMonth() === second.getMonth()
        && first.getDate() === second.getDate();
}

/**
 * Match Discord's visible message-group boundaries without consulting the
 * globally selected channel. Following messages render as continuation rows
 * without repeating the author header and avatar.
 */
export function canGroupWithPrevious(message: Message, previous: Message, channel: Channel): boolean {
    if (!MessageTypeSets.USER_MESSAGE.has(message.type) || !MessageTypeSets.USER_MESSAGE.has(previous.type)) return false;
    if (message.author.id !== previous.author.id || message.webhookId !== previous.webhookId) return false;
    if (message.messageReference != null || message.isFirstMessageInForumPost(channel)) return false;

    const { timestamp } = message;
    const { timestamp: previousTimestamp } = previous;
    if (!isSameCalendarDay(timestamp, previousTimestamp)) return false;

    const elapsed = timestamp.getTime() - previousTimestamp.getTime();
    return elapsed >= 0 && elapsed < MESSAGE_GROUP_WINDOW_MS;
}
