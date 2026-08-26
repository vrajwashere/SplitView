/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel } from "@vencord/discord-types";
import { PermissionsBits, PermissionStore } from "@webpack/common";

export interface SendAvailability {
    canAttachFiles: boolean;
    canSend: boolean;
    reason?: string;
}

export function getSendAvailability(channel: Channel | undefined): SendAvailability {
    if (!channel) return { canAttachFiles: false, canSend: false, reason: "Channel unavailable" };

    if (!channel.isPrivate() && !PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel)) {
        return { canAttachFiles: false, canSend: false, reason: "You cannot view this channel" };
    }

    if (channel.isThread() && (channel.threadMetadata?.archived || channel.threadMetadata?.locked)) {
        return { canAttachFiles: false, canSend: false, reason: "This thread is archived or locked" };
    }

    if (channel.isPrivate()) return { canAttachFiles: true, canSend: true };

    const permission = channel.isThread()
        ? PermissionsBits.SEND_MESSAGES_IN_THREADS
        : PermissionsBits.SEND_MESSAGES;

    return PermissionStore.can(permission, channel)
        ? {
            canAttachFiles: PermissionStore.can(PermissionsBits.ATTACH_FILES, channel),
            canSend: true
        }
        : {
            canAttachFiles: false,
            canSend: false,
            reason: "You cannot send messages in this channel"
        };
}
