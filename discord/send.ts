/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendMessage } from "@utils/discord";
import type { Channel, CloudUpload, Message } from "@vencord/discord-types";
import { MessageActions } from "@webpack/common";

export async function sendPaneMessage(
    channelId: string,
    content: string,
    attachmentsToUpload: CloudUpload[] = []
): Promise<void> {
    await sendMessage(channelId, { content }, true, { attachmentsToUpload });
}

export async function sendPaneReply(
    channel: Channel,
    message: Message,
    content: string,
    shouldMention: boolean,
    attachmentsToUpload: CloudUpload[] = []
): Promise<void> {
    const options = MessageActions.getSendMessageOptionsForReply({
        channel,
        message,
        shouldMention,
        showMentionToggle: !channel.isPrivate()
    });

    await sendMessage(channel.id, { content }, true, { ...options, attachmentsToUpload });
}

export async function editPaneMessage(channelId: string, messageId: string, content: string): Promise<void> {
    await Promise.resolve(MessageActions.editMessage(channelId, messageId, { content }));
}

export async function deletePaneMessage(channelId: string, messageId: string): Promise<void> {
    await Promise.resolve(MessageActions.deleteMessage(channelId, messageId));
}
