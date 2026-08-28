/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel } from "@vencord/discord-types";
import { ChannelStore, React, useState, useStateFromStores } from "@webpack/common";
import type { ComponentType, KeyboardEvent } from "react";

import { SplitComposerTarget, SplitPaneProvider } from "../context/SplitPaneContext";
import { getChannel, isSupportedMessageChannel } from "../discord/channel";
import { usePaneFocusRef } from "../keyboard/ComposerFocusManager";
import { closeTab, getLayoutState, setActivePane, useIsPaneActive, usePaneState } from "../state/layoutStore";
import { StableMessageList } from "./MessageList";
import { StablePaneTabs } from "./PaneTabs";
import { StableSplitComposer } from "./SplitComposer";

const MAXIMUM_WARM_TABS_PER_PANE = 2;

interface SplitChannelPaneProps {
    active: boolean;
    channel: Channel;
    paneId: string;
    tabId: string;
}

interface SplitPaneProps {
    paneId: string;
}

interface CachedSplitChannelProps {
    active: boolean;
    channelId: string;
    paneId: string;
    tabId: string;
}

function SplitChannelPane({ active, channel, paneId, tabId }: SplitChannelPaneProps) {
    const [composerTarget, setComposerTarget] = useState<SplitComposerTarget>(null);
    const beginReply = React.useCallback((messageId: string) => {
        setComposerTarget({ kind: "reply", messageId });
    }, []);
    const beginEdit = React.useCallback((messageId: string, initialContent: string) => {
        setComposerTarget({ kind: "edit", messageId, initialContent });
    }, []);
    const clearComposerTargetForMessage = React.useCallback((messageId: string) => {
        setComposerTarget(current => current?.messageId === messageId ? null : current);
    }, []);
    const context = React.useMemo(() => ({
        active,
        paneId,
        channelId: channel.id,
        guildId: channel.guild_id || undefined,
        beginReply,
        beginEdit,
        clearComposerTargetForMessage
    }), [active, beginEdit, beginReply, channel.guild_id, channel.id, clearComposerTargetForMessage, paneId]);
    const composerContext = React.useMemo(() => ({
        composerTarget,
        setComposerTarget
    }), [composerTarget]);

    React.useLayoutEffect(() => {
        setComposerTarget(null);
    }, [channel.id]);

    return (
        <SplitPaneProvider value={context} composerValue={composerContext}>
            <div className="vc-splitview-channel-view" hidden={!active}>
                <StableMessageList active={active} viewportKey={tabId} />
                <StableSplitComposer />
            </div>
        </SplitPaneProvider>
    );
}

function CachedSplitChannel({ active, channelId, paneId, tabId }: CachedSplitChannelProps) {
    const channel = useStateFromStores(
        [ChannelStore],
        () => getChannel(channelId),
        [channelId]
    );

    if (!isSupportedMessageChannel(channel)) {
        return active
            ? <div className="vc-splitview-status vc-splitview-status-error">SplitView cannot render this channel.</div>
            : null;
    }

    return <SplitChannelPane active={active} channel={channel} paneId={paneId} tabId={tabId} />;
}

export function SplitPane({ paneId }: SplitPaneProps) {
    const pane = usePaneState(paneId);
    const active = useIsPaneActive(paneId);
    const paneFocusRef = usePaneFocusRef(paneId);
    const cachedTabIdsRef = React.useRef<string[]>([]);
    const activeChannel = useStateFromStores(
        [ChannelStore],
        () => pane ? getChannel(pane.channelId) : undefined,
        [pane?.channelId]
    );

    if (!pane) return null;

    const availableTabIds = new Set(pane.tabs.map(tab => tab.id));
    const cachedTabIds = [
        pane.activeTabId,
        ...cachedTabIdsRef.current.filter(tabId => tabId !== pane.activeTabId && availableTabIds.has(tabId))
    ].slice(0, MAXIMUM_WARM_TABS_PER_PANE);
    cachedTabIdsRef.current = cachedTabIds;

    function onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (!event.ctrlKey || event.altKey || event.metaKey) return;
        // Read the store rather than the last render so closely spaced key
        // events always advance from the most recently selected tab.
        const currentPane = getLayoutState().panes[paneId];
        if (!currentPane) return;
        if (event.key.toLowerCase() === "w") {
            event.preventDefault();
            event.stopPropagation();
            closeTab(paneId, currentPane.activeTabId);
        }
    }

    return (
        <section
            ref={paneFocusRef}
            tabIndex={-1}
            className={`vc-splitview-pane${active ? " vc-splitview-pane-active" : ""}`}
            aria-label={`Split view for ${activeChannel?.name || "direct message"}`}
            onPointerDown={() => setActivePane(paneId)}
            onFocusCapture={() => setActivePane(paneId)}
            onKeyDown={onKeyDown}
        >
            <StablePaneTabs paneId={paneId} />
            <div className="vc-splitview-channel-stack">
                {cachedTabIds.map(tabId => {
                    const tab = pane.tabs.find(candidate => candidate.id === tabId);
                    return tab && (
                        <CachedSplitChannel
                            key={tab.id}
                            active={tab.id === pane.activeTabId}
                            channelId={tab.channelId}
                            paneId={paneId}
                            tabId={tab.id}
                        />
                    );
                })}
            </div>
        </section>
    );
}

let memoizedSplitPane: ComponentType<SplitPaneProps> | undefined;

/** Resolve React.memo only after Discord's lazy React export is ready. */
export function StableSplitPane(props: SplitPaneProps) {
    const MemoizedSplitPane = memoizedSplitPane ??= React.memo(SplitPane);
    return <MemoizedSplitPane {...props} />;
}
