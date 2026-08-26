/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, type NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { ChannelStore, Menu, SelectedChannelStore, showToast, Toasts } from "@webpack/common";
import type { ReactElement } from "react";

import { type PrimaryChatProps, SplitWorkspace } from "./components/SplitWorkspace";
import { canViewChannel, getChannel, isChannelAvailable, isSupportedMessageChannel } from "./discord/channel";
import { syncLiveMessages } from "./discord/messages";
import { getChannelDragProps } from "./drag/DragManager";
import { logger } from "./logger";
import { settings } from "./settings";
import { closeAllPanes, equalizeViewSizes, flushLayoutPersistence, flushStagedDrafts, getLayoutState, initializeLayout, openChannel, pruneUnavailableChannels } from "./state/layoutStore";
import { clearMessageViewportStates } from "./state/messageViewportStore";
import managedStyle from "./styles.css?managed";

function openChannelInSplit(channel: Channel | undefined): void {
    if (!isSupportedMessageChannel(channel)) {
        showToast("SplitView only supports message-based channels.", Toasts.Type.FAILURE);
        return;
    }
    if (!canViewChannel(channel)) {
        showToast("You cannot view that channel.", Toasts.Type.FAILURE);
        return;
    }

    if (!openChannel(channel.id)) {
        showToast("SplitView has reached its tab capacity.", Toasts.Type.FAILURE);
    }
}

function makeOpenMenuItem(channel: Channel) {
    return (
        <Menu.MenuItem
            key="vc-splitview-open"
            id="vc-splitview-open"
            label="Open in Split View"
            action={() => openChannelInSplit(channel)}
        />
    );
}

function insertOpenMenuItem(children: Parameters<NavContextMenuPatchCallback>[0], channel: Channel | undefined, anchors: string[]) {
    if (!isSupportedMessageChannel(channel) || !canViewChannel(channel)) return;

    const group = findGroupChildrenByChildId(anchors, children);
    if (!group) {
        children.splice(-1, 0, <Menu.MenuGroup>{makeOpenMenuItem(channel)}</Menu.MenuGroup>);
        return;
    }

    const closeActionIndex = group.findIndex(item => anchors.includes(item?.props?.id));
    group.splice(closeActionIndex < 0 ? group.length : closeActionIndex, 0, makeOpenMenuItem(channel));
}

const patchChannelContextMenu: NavContextMenuPatchCallback = (children, props) => {
    insertOpenMenuItem(children, props?.channel as Channel | undefined, ["mark-channel-read", "mute-channel"]);
};

const patchDirectMessageContextMenu: NavContextMenuPatchCallback = (children, props) => {
    insertOpenMenuItem(children, props?.channel as Channel | undefined, ["close-dm", "leave-channel"]);
};

function pruneRestoredLayout(): void {
    pruneUnavailableChannels(isChannelAvailable);
}

function isSplitViewChannel(channelId: string): boolean {
    return Object.values(getLayoutState().panes)
        .some(pane => pane.tabs.some(tab => tab.channelId === channelId));
}

export default definePlugin({
    name: "SplitView",
    description: "Arrange up to four live Discord channels in draggable split views",
    authors: [{ name: "Vraj", id: 0n }],
    tags: ["Chat", "Organisation"],
    settings,
    managedStyle,

    patches: [
        {
            find: "Missing channel in Channel.renderChat",
            // WebpackPatcher syntax-checks every replacement independently, so
            // the opening and closing wrapper must be introduced atomically.
            replacement: {
                match: /(\(0,\i\.jsxs\)\("div",\{"data-has-border":[\s\S]+?\}\))(?=,this\.renderThreadSidebar\(\)\]\}\)\}\})/,
                replace: "$self.renderSplitView($1)"
            }
        },
        {
            find: 'location:"PrivateChannel"',
            replacement: {
                match: /return\(0,\i\.jsx\)\(\i\.\i,\{id:(\i)\.id,children:\i=>\{[\s\S]{0,400}?return\(0,\i\.jsxs\)\(\i,\{/,
                replace: "$&...$self.getChannelDragProps($1),"
            }
        },
        {
            find: /"data-dnd-name":\(0,\i\.\i\)\(\i,\i\.\i,\i\.\i\),/,
            all: true,
            replacement: {
                match: /("data-dnd-name":\(0,\i\.\i\)\((\i),\i\.\i,\i\.\i\),)/g,
                replace: "$1...$self.getChannelDragProps($2),"
            }
        },
        {
            find: '"MessageStore"',
            replacement: {
                // Discord normally discards MESSAGE_CREATE when a background
                // channel cache is not ready. SplitView renders that channel,
                // so keep accepting messages during the cache-recovery race.
                match: /:!\(!(\i)\.ready\|\|/,
                replace: ":!(!$1.ready&&!$self.isSplitViewChannel($1.channelId)||"
            }
        }
    ],

    contextMenus: {
        "channel-context": patchChannelContextMenu,
        "thread-context": patchChannelContextMenu,
        "gdm-context": patchDirectMessageContextMenu,
        "user-context": patchDirectMessageContextMenu
    },

    toolboxActions: {
        "Split current channel": () => openChannelInSplit(getChannel(SelectedChannelStore.getChannelId())),
        "Equalize view sizes (Ctrl+Alt+0)": equalizeViewSizes,
        "Close Split View": closeAllPanes
    },

    flux: {
        PASSIVE_UPDATE_V2({ channels }: { channels: Array<{ id: string; lastMessageId?: string | null; }>; }) {
            for (const { id: channelId, lastMessageId } of channels) {
                if (!lastMessageId || !isSplitViewChannel(channelId)) continue;
                queueMicrotask(() => {
                    void syncLiveMessages(channelId, lastMessageId).catch(error => {
                        logger.error("Failed to reconcile passive split channel update", { channelId, lastMessageId, error });
                    });
                });
            }
        },
        MESSAGE_CREATE({ channelId, message, optimistic }: {
            channelId: string;
            message: { id: string; };
            optimistic?: boolean;
        }) {
            if (optimistic || !isSplitViewChannel(channelId)) return;

            // Run after Discord's stores have handled the event. If MessageStore
            // rejected it because this pane is no longer at the live edge, the
            // reconciliation fetch repairs the cache without redispatch loops.
            queueMicrotask(() => {
                void syncLiveMessages(channelId, message.id).catch(error => {
                    logger.error("Failed to reconcile split channel message", {
                        channelId,
                        messageId: message.id,
                        error
                    });
                });
            });
        },
        CHANNEL_DELETE() {
            pruneRestoredLayout();
        },
        CHANNEL_UPDATE() {
            pruneRestoredLayout();
        },
        GUILD_DELETE() {
            pruneRestoredLayout();
        }
    },

    start() {
        void initializeLayout()
            .then(pruneRestoredLayout)
            .catch(error => logger.error("Failed to initialize SplitView", error));
    },

    stop() {
        clearMessageViewportStates();
        flushStagedDrafts();
        void flushLayoutPersistence();
    },

    renderSplitView(primary: ReactElement<PrimaryChatProps>) {
        return <SplitWorkspace primary={primary} />;
    },

    getChannelDragProps,

    isSplitViewChannel(channelId: string) {
        return isSplitViewChannel(channelId);
    },

    openChannel(channelId: string) {
        openChannelInSplit(ChannelStore.getChannel(channelId));
    }
});
