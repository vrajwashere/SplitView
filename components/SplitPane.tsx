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
import type { SplitPaneRecord } from "../state/types";
import { StableMessageList } from "./MessageList";
import { StablePaneTabs } from "./PaneTabs";
import { StableSplitComposer } from "./SplitComposer";

interface SplitChannelPaneProps {
    active: boolean;
    channel: Channel;
    pane: SplitPaneRecord;
    paneId: string;
}

interface SplitPaneProps {
    paneId: string;
}

function SplitChannelPane({ active, channel, pane, paneId }: SplitChannelPaneProps) {
    const paneFocusRef = usePaneFocusRef(paneId);
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
        paneId,
        channelId: channel.id,
        guildId: channel.guild_id || undefined,
        beginReply,
        beginEdit,
        clearComposerTargetForMessage
    }), [beginEdit, beginReply, channel.guild_id, channel.id, clearComposerTargetForMessage, paneId]);
    const composerContext = React.useMemo(() => ({
        composerTarget,
        setComposerTarget
    }), [composerTarget]);

    React.useLayoutEffect(() => {
        setComposerTarget(null);
    }, [channel.id]);

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
            return;
        }
    }

    return (
        <SplitPaneProvider value={context} composerValue={composerContext}>
            <section
                ref={paneFocusRef}
                tabIndex={-1}
                className={`vc-splitview-pane${active ? " vc-splitview-pane-active" : ""}`}
                aria-label={`Split view for ${channel.name || "direct message"}`}
                onPointerDown={() => setActivePane(paneId)}
                onFocusCapture={() => setActivePane(paneId)}
                onKeyDown={onKeyDown}
            >
                <StablePaneTabs paneId={paneId} />
                <StableMessageList key={pane.activeTabId} viewportKey={pane.activeTabId} />
                <StableSplitComposer key={channel.id} />
            </section>
        </SplitPaneProvider>
    );
}

export function SplitPane({ paneId }: SplitPaneProps) {
    const pane = usePaneState(paneId);
    const active = useIsPaneActive(paneId);
    const channel = useStateFromStores(
        [ChannelStore],
        () => pane ? getChannel(pane.channelId) : undefined,
        [pane?.channelId]
    );

    if (!pane) return null;
    if (!isSupportedMessageChannel(channel)) {
        return <div className="vc-splitview-status vc-splitview-status-error">SplitView cannot render this channel.</div>;
    }

    return (
        <SplitChannelPane
            active={active}
            channel={channel}
            pane={pane}
            paneId={paneId}
        />
    );
}

let memoizedSplitPane: ComponentType<SplitPaneProps> | undefined;

/** Resolve React.memo only after Discord's lazy React export is ready. */
export function StableSplitPane(props: SplitPaneProps) {
    const MemoizedSplitPane = memoizedSplitPane ??= React.memo(SplitPane);
    return <MemoizedSplitPane {...props} />;
}
