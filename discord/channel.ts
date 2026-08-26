/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel } from "@vencord/discord-types";
import { ChannelRouter, ChannelStore, GuildStore, IconUtils, PermissionsBits, PermissionStore, UserStore } from "@webpack/common";

export interface ChannelHeaderDetails {
    title: string;
    subtitle?: string;
    iconUrl?: string;
}

export function getChannel(channelId: string): Channel | undefined {
    return ChannelStore.getChannel(channelId) as Channel | undefined;
}

export function isSupportedMessageChannel(channel: Channel | undefined): channel is Channel {
    if (!channel || channel.isCategory() || channel.isDirectory()) return false;
    // DMs support voice calls, so Discord's broad isVocal() predicate is true
    // for them. Only reject actual guild voice/stage channels here.
    if (!channel.isPrivate() && channel.isGuildVocal()) return false;
    if (channel.isForumLikeChannel() && !channel.isThread()) return false;
    return channel.isPrivate() || channel.isThread() || Boolean(channel.guild_id);
}

export function canViewChannel(channel: Channel | undefined): channel is Channel {
    if (!isSupportedMessageChannel(channel)) return false;
    return channel.isPrivate() || PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel);
}

export function isChannelAvailable(channelId: string): boolean {
    return canViewChannel(getChannel(channelId));
}

function getDirectMessageHeader(channel: Channel): ChannelHeaderDetails {
    const recipient = UserStore.getUser(channel.getRecipientId() ?? channel.recipients?.[0]);
    return {
        title: recipient?.globalName ?? recipient?.username ?? "Direct Message",
        subtitle: recipient ? `@${recipient.username}` : "Direct Message",
        iconUrl: recipient ? IconUtils.getUserAvatarURL(recipient) : undefined
    };
}

function getGroupMessageHeader(channel: Channel): ChannelHeaderDetails {
    const recipientNames = channel.recipients
        ?.map(userId => UserStore.getUser(userId)?.globalName ?? UserStore.getUser(userId)?.username)
        .filter(Boolean)
        .join(", ");

    return {
        title: channel.name || recipientNames || "Group DM",
        subtitle: "Group DM",
        iconUrl: IconUtils.getChannelIconURL(channel)
    };
}

export function getChannelHeaderDetails(channel: Channel): ChannelHeaderDetails {
    if (channel.isDM()) return getDirectMessageHeader(channel);
    if (channel.isGroupDM()) return getGroupMessageHeader(channel);

    const guild = GuildStore.getGuild(channel.guild_id);
    if (channel.isThread()) {
        const parent = getChannel(channel.parent_id);
        return {
            title: channel.name || "Thread",
            subtitle: [guild?.name, parent?.name ? `#${parent.name}` : undefined].filter(Boolean).join(" · "),
            iconUrl: guild ? IconUtils.getGuildIconURL(guild) : undefined
        };
    }

    return {
        title: channel.name ? `#${channel.name}` : "Channel",
        subtitle: guild?.name,
        iconUrl: guild ? IconUtils.getGuildIconURL(guild) : undefined
    };
}

export function openAsPrimary(channelId: string): void {
    ChannelRouter.transitionToChannel(channelId);
}
