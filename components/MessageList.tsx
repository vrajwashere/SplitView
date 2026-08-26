/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getUserSettingLazy } from "@api/UserSettings";
import type { Channel, Message } from "@vencord/discord-types";
import { AccessibilityStore, MessageStore, MessageTypeSets, PermissionsBits, PermissionStore, React, ReadStateStore, useEffect, useLayoutEffect, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";
import type { ComponentType, CSSProperties } from "react";

import { applyMessageCompatibilityAdapters } from "../compatibility";
import { type SplitPaneContextValue, useSplitPane } from "../context/SplitPaneContext";
import { getChannel } from "../discord/channel";
import { canGroupWithPrevious } from "../discord/grouping";
import { ensureMessages, fetchOlderMessages, INITIAL_MESSAGE_COUNT, syncLiveMessages } from "../discord/messages";
import { logger } from "../logger";
import { settings } from "../settings";
import { useIsPaneActive } from "../state/layoutStore";
import { getMessageViewportState, rememberMessageViewportState } from "../state/messageViewportStore";
import { GroupedChannelMessage } from "./GroupedChannelMessage";
import { SplitMessageActions } from "./SplitMessageActions";
import { UserProfileClickHandler } from "./UserProfileClickHandler";

const MessageDisplayCompact = getUserSettingLazy("textAndImages", "messageDisplayCompact")!;
const MESSAGE_OVERSCAN_PX = 600;
const COZY_ESTIMATED_MESSAGE_HEIGHT = 56;
const COMPACT_ESTIMATED_MESSAGE_HEIGHT = 32;
const MESSAGE_LIST_PADDING_TOP = 8;
const MESSAGE_LIST_PADDING_BOTTOM = 16;

interface MessageViewport {
    height: number;
    messageOffsetTop: number;
    scrollTop: number;
}

interface MessageRowProps {
    canManageMessages: boolean;
    channel: Channel;
    compact: boolean;
    currentUserId?: string;
    message: Message;
    pane: SplitPaneContextValue;
    previousMessage?: Message;
    registerRow(messageId: string, row: HTMLDivElement | null): void;
    top: number;
}

function lowerBound(values: readonly number[], target: number): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (values[middle] < target) low = middle + 1;
        else high = middle;
    }
    return low;
}

function MessageRow({ canManageMessages, channel, compact, currentUserId, message, pane, previousMessage, registerRow, top }: MessageRowProps) {
    const isContinuation = Boolean(
        previousMessage && canGroupWithPrevious(message, previousMessage, channel)
    );
    const props = applyMessageCompatibilityAdapters({
        id: `splitview-${pane.paneId}-${message.id}`,
        channel,
        message,
        compact,
        subscribeToComponentDispatch: false
    }, pane);
    const canEdit = !message.deleted
        && message.author.id === currentUserId
        && MessageTypeSets.USER_MESSAGE.has(message.type)
        && message.state === "SENT"
        && message.content.length > 0;
    const canDelete = !message.deleted && Boolean(
        !MessageTypeSets.UNDELETABLE.has(message.type)
        && ((currentUserId && message.canDeleteOwnMessage(currentUserId)) || canManageMessages)
    );
    const setRowRef = React.useCallback((row: HTMLDivElement | null) => {
        registerRow(message.id, row);
    }, [message.id, registerRow]);

    return (
        <div
            ref={setRowRef}
            className={`vc-splitview-message-row vc-splitview-message-row-virtual${message.mentioned ? " vc-splitview-message-mentioned" : ""}`}
            data-message-id={message.id}
            data-group-continuation={isContinuation || undefined}
            style={{ top }}
        >
            <GroupedChannelMessage messageProps={props} />
            <SplitMessageActions
                channel={channel}
                message={message}
                canEdit={canEdit}
                canDelete={canDelete}
            />
        </div>
    );
}

let memoizedMessageRow: ComponentType<MessageRowProps> | undefined;

function StableMessageRow(props: MessageRowProps) {
    const MemoizedMessageRow = memoizedMessageRow ??= React.memo(MessageRow);
    return <MemoizedMessageRow {...props} />;
}

function getNativeMessageGroupMargin(configuredSpacing: number): string {
    // Discord maps its 0/4/8/16/24 setting to 1/5/9/17/25px margins.
    return `${(Number.isFinite(configuredSpacing) ? configuredSpacing : 16) + 1}px`;
}

export function MessageList({ viewportKey }: { viewportKey: string; }) {
    const pane = useSplitPane();
    const { channelId } = pane;
    const paneActive = useIsPaneActive(pane.paneId);
    const { maximumRenderedMessages } = settings.use(["maximumRenderedMessages"]);
    const compact = MessageDisplayCompact.useSetting();
    const [restoredViewport] = useState(() => getMessageViewportState(viewportKey));
    const [visibleLimit, setVisibleLimit] = useState(() => Math.min(
        restoredViewport?.visibleLimit ?? 100,
        maximumRenderedMessages
    ));
    // Cached messages can render on the first commit while live reconciliation
    // runs in the background. Do not flash a loading screen on every tab switch.
    const [initialLoadPending, setInitialLoadPending] = useState(() => MessageStore.getMessages(channelId)._array.length === 0);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const messageListRef = useRef<HTMLDivElement>(null);
    const observedRowsRef = useRef(new Map<string, HTMLDivElement>());
    const rowObserverRef = useRef<ResizeObserver | undefined>(undefined);
    const rowHeightsRef = useRef(restoredViewport && restoredViewport.compact === compact
        ? restoredViewport.rowHeights
        : new Map<string, number>());
    const measuredCompactRef = useRef(compact);
    const viewportFrameRef = useRef<number | undefined>(undefined);
    const visibleLimitRef = useRef(visibleLimit);
    const stickToBottomRef = useRef(restoredViewport?.stickToBottom ?? true);
    const restorationPendingRef = useRef(Boolean(restoredViewport));
    const previousScrollHeightRef = useRef<number | undefined>(undefined);
    const historyRequestRef = useRef(false);
    const [measurementVersion, setMeasurementVersion] = useState(0);
    const [viewport, setViewport] = useState<MessageViewport>({
        height: restoredViewport?.height ?? 0,
        messageOffsetTop: restoredViewport?.messageOffsetTop ?? 0,
        scrollTop: restoredViewport?.scrollTop ?? 0
    });
    visibleLimitRef.current = visibleLimit;

    function rememberViewport(scroller: HTMLDivElement): void {
        rememberMessageViewportState(viewportKey, {
            compact,
            height: scroller.clientHeight,
            messageOffsetTop: messageListRef.current?.offsetTop ?? 0,
            rowHeights: rowHeightsRef.current,
            scrollTop: scroller.scrollTop,
            stickToBottom: stickToBottomRef.current,
            visibleLimit: visibleLimitRef.current
        });
    }

    function updateViewport(scroller: HTMLDivElement): void {
        const nextViewport = {
            height: scroller.clientHeight,
            messageOffsetTop: messageListRef.current?.offsetTop ?? 0,
            scrollTop: scroller.scrollTop
        };
        setViewport(current => (
            current.height === nextViewport.height
            && current.messageOffsetTop === nextViewport.messageOffsetTop
            && current.scrollTop === nextViewport.scrollTop
                ? current
                : nextViewport
        ));
        rememberViewport(scroller);
    }

    function scheduleViewportUpdate(scroller: HTMLDivElement): void {
        if (viewportFrameRef.current != null) return;
        viewportFrameRef.current = requestAnimationFrame(() => {
            viewportFrameRef.current = undefined;
            if (scroller.isConnected) updateViewport(scroller);
        });
    }

    const registerRow = React.useCallback((messageId: string, row: HTMLDivElement | null) => {
        const previousRow = observedRowsRef.current.get(messageId);
        if (previousRow && previousRow !== row) rowObserverRef.current?.unobserve(previousRow);
        if (!row) {
            observedRowsRef.current.delete(messageId);
            return;
        }

        observedRowsRef.current.set(messageId, row);
        rowObserverRef.current?.observe(row);
    }, []);

    const snapshot = useStateFromStores([MessageStore], () => {
        const messages = MessageStore.getMessages(channelId);
        return {
            // Guild-channel caches can append to this array in place. Snapshot
            // the bounded window so additions invalidate the React selector.
            messages: messages._array.slice(-maximumRenderedMessages),
            hasMoreBefore: messages.hasMoreBefore,
            loading: MessageStore.isLoadingMessages(channelId) || messages.loadingMore,
            ready: messages.ready,
            error: messages.error
        };
    }, [channelId, maximumRenderedMessages], (previous, next) => (
        previous.messages.length === next.messages.length
        && previous.messages.every((message, index) => message === next.messages[index])
        && previous.hasMoreBefore === next.hasMoreBefore
        && previous.loading === next.loading
        && previous.ready === next.ready
        && previous.error === next.error
    ));
    const observedLastMessageId = useStateFromStores(
        [ReadStateStore],
        () => ReadStateStore.lastMessageId(channelId),
        [channelId]
    );

    useEffect(() => {
        const cached = MessageStore.getMessages(channelId);
        if (restoredViewport && cached.ready && cached.hasFetched
            && (cached._array.length >= INITIAL_MESSAGE_COUNT || !cached.hasMoreBefore)) {
            // This tab was already preloaded. Cache expiry and new messages
            // still use the recovery/live-sync effects below.
            setInitialLoadPending(false);
            return;
        }
        let disposed = false;
        void ensureMessages(channelId)
            .catch(() => undefined)
            .finally(() => {
                if (!disposed) setInitialLoadPending(false);
            });

        return () => {
            disposed = true;
        };
    }, [channelId, restoredViewport]);

    useEffect(() => {
        // Discord expires background channel caches even though this channel is
        // still visible in SplitView. Restore it as soon as that happens so the
        // native store can continue accepting ordinary MESSAGE_CREATE events.
        if (initialLoadPending || snapshot.loading || snapshot.ready) return;
        void ensureMessages(channelId).catch(error => {
            logger.error("Failed to recover expired message cache", { channelId, error });
        });
    }, [channelId, initialLoadPending, snapshot.loading, snapshot.ready]);

    useEffect(() => {
        if (initialLoadPending || !observedLastMessageId) return;
        void syncLiveMessages(channelId, observedLastMessageId).catch(error => {
            logger.error("Failed to reconcile split channel with read state", {
                channelId,
                observedLastMessageId,
                error
            });
        });
    }, [channelId, initialLoadPending, observedLastMessageId]);

    useLayoutEffect(() => {
        setVisibleLimit(limit => Math.min(limit, maximumRenderedMessages));
        previousScrollHeightRef.current = undefined;
        historyRequestRef.current = false;
    }, [maximumRenderedMessages]);

    useLayoutEffect(() => () => {
        const scroller = scrollerRef.current;
        if (scroller) rememberViewport(scroller);
        if (viewportFrameRef.current != null) cancelAnimationFrame(viewportFrameRef.current);
        viewportFrameRef.current = undefined;
    }, [viewportKey, visibleLimit]);

    useEffect(() => {
        const scroller = scrollerRef.current;
        const messageList = messageListRef.current;
        if (!scroller || !messageList || initialLoadPending || typeof ResizeObserver === "undefined") return;

        let animationFrame: number | undefined;
        const refreshViewport = () => {
            if (animationFrame != null) cancelAnimationFrame(animationFrame);
            animationFrame = requestAnimationFrame(() => {
                animationFrame = undefined;
                if (!scroller.isConnected || scroller.clientHeight === 0) return;
                if (stickToBottomRef.current && previousScrollHeightRef.current == null) {
                    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
                }
                // Resizing can clamp scrollTop without a user scroll. Even
                // panes reading older messages must refresh their visible rows.
                updateViewport(scroller);
            });
        };
        const observer = new ResizeObserver(refreshViewport);
        observer.observe(scroller);
        observer.observe(messageList);
        refreshViewport();

        return () => {
            observer.disconnect();
            if (animationFrame != null) cancelAnimationFrame(animationFrame);
        };
    }, [channelId, compact, initialLoadPending]);

    useLayoutEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller || initialLoadPending) return;

        if (previousScrollHeightRef.current != null) {
            scroller.scrollTop += scroller.scrollHeight - previousScrollHeightRef.current;
            previousScrollHeightRef.current = scroller.scrollHeight;
        } else if (restorationPendingRef.current) {
            scroller.scrollTop = restoredViewport?.stickToBottom
                ? scroller.scrollHeight
                : restoredViewport?.scrollTop ?? 0;
            restorationPendingRef.current = false;
        } else if (stickToBottomRef.current) {
            scroller.scrollTop = scroller.scrollHeight;
        }
        updateViewport(scroller);
    }, [channelId, initialLoadPending, measurementVersion, paneActive, snapshot.hasMoreBefore, snapshot.messages.length, snapshot.messages.at(0)?.id, snapshot.messages.at(-1)?.id, visibleLimit]);

    const channel = getChannel(channelId);
    const visibleMessages = React.useMemo(
        () => snapshot.messages.slice(-Math.min(visibleLimit, maximumRenderedMessages)),
        [snapshot.messages, visibleLimit, maximumRenderedMessages]
    );
    const currentUserId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
    const messageGroupSpacing = useStateFromStores(
        [AccessibilityStore],
        () => AccessibilityStore.messageGroupSpacing
    );
    const messageScrollerStyle = {
        "--vc-splitview-native-group-start-margin": getNativeMessageGroupMargin(messageGroupSpacing)
    } as CSSProperties;
    const canManageMessages = useStateFromStores(
        [PermissionStore],
        () => Boolean(channel && !channel.isPrivate() && PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel)),
        [channelId]
    );
    const estimatedMessageHeight = compact ? COMPACT_ESTIMATED_MESSAGE_HEIGHT : COZY_ESTIMATED_MESSAGE_HEIGHT;
    const offsets = React.useMemo(() => {
        const positions = [0];
        for (const message of visibleMessages) {
            positions.push(positions.at(-1)! + (rowHeightsRef.current.get(message.id) ?? estimatedMessageHeight));
        }
        return positions;
    }, [visibleMessages, estimatedMessageHeight, measurementVersion]);
    const totalMessageHeight = offsets.at(-1) ?? 0;
    const messageListHeight = totalMessageHeight + MESSAGE_LIST_PADDING_TOP + MESSAGE_LIST_PADDING_BOTTOM;
    // A restored or resized viewport can briefly exceed the new content height.
    // Keep at least the last visible window mounted until DOM measurement syncs.
    const relativeScrollTop = Math.min(
        Math.max(0, viewport.scrollTop - viewport.messageOffsetTop),
        Math.max(0, messageListHeight - viewport.height)
    );
    const startIndex = viewport.height > 0
        ? Math.max(0, lowerBound(offsets, Math.max(0, relativeScrollTop - MESSAGE_OVERSCAN_PX)) - 1)
        : Math.max(0, visibleMessages.length - 30);
    const endIndex = viewport.height > 0
        ? Math.min(visibleMessages.length, lowerBound(offsets, relativeScrollTop + viewport.height + MESSAGE_OVERSCAN_PX) + 1)
        : visibleMessages.length;
    const renderedMessages = visibleMessages.slice(startIndex, endIndex);

    useLayoutEffect(() => {
        if (measuredCompactRef.current === compact) return;
        measuredCompactRef.current = compact;
        rowHeightsRef.current.clear();
        setMeasurementVersion(version => version + 1);
    }, [compact]);

    useEffect(() => {
        if (rowHeightsRef.current.size <= maximumRenderedMessages * 2) return;
        const retainedMessageIds = new Set(visibleMessages.map(message => message.id));
        for (const messageId of rowHeightsRef.current.keys()) {
            if (!retainedMessageIds.has(messageId)) rowHeightsRef.current.delete(messageId);
        }
    }, [channelId, maximumRenderedMessages, visibleMessages.at(0)?.id, visibleMessages.at(-1)?.id, visibleMessages.length]);

    useLayoutEffect(() => {
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(entries => {
            let changed = false;
            for (const entry of entries) {
                const { messageId } = (entry.target as HTMLElement).dataset;
                const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
                if (!messageId || height <= 0 || Math.abs((rowHeightsRef.current.get(messageId) ?? 0) - height) < 0.5) continue;
                rowHeightsRef.current.set(messageId, height);
                changed = true;
            }
            if (changed) setMeasurementVersion(version => version + 1);
        });
        rowObserverRef.current = observer;
        for (const row of observedRowsRef.current.values()) observer.observe(row);
        return () => {
            observer.disconnect();
            rowObserverRef.current = undefined;
        };
    }, [channelId]);

    async function loadEarlier() {
        if (historyRequestRef.current) return;
        const scroller = scrollerRef.current;
        if (scroller) previousScrollHeightRef.current = scroller.scrollHeight;
        historyRequestRef.current = true;
        setVisibleLimit(limit => Math.min(limit + 50, maximumRenderedMessages));
        try {
            await fetchOlderMessages(channelId);
        } catch (error) {
            logger.error("Failed to fetch earlier messages", { channelId, error });
        } finally {
            // Store notifications and the visible-window update can render in
            // either order. Keep compensating for height changes until both
            // have had two paint frames to settle, then release the anchor.
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const currentScroller = scrollerRef.current;
                if (currentScroller && previousScrollHeightRef.current != null) {
                    currentScroller.scrollTop += currentScroller.scrollHeight - previousScrollHeightRef.current;
                    updateViewport(currentScroller);
                }
                previousScrollHeightRef.current = undefined;
                historyRequestRef.current = false;
            }));
        }
    }

    if (!channel) return <div className="vc-splitview-status">Channel unavailable.</div>;

    return (
        <div
            ref={scrollerRef}
            className="vc-splitview-message-scroller"
            style={messageScrollerStyle}
            role="log"
            aria-live="polite"
            aria-label="Channel messages"
            onScroll={event => {
                const element = event.currentTarget;
                stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                scheduleViewportUpdate(element);
            }}
        >
            {!initialLoadPending && snapshot.hasMoreBefore && (
                <button
                    type="button"
                    className="vc-splitview-load-earlier"
                    disabled={snapshot.loading}
                    onClick={() => void loadEarlier()}
                >
                    {snapshot.loading ? "Loading…" : "Load earlier messages"}
                </button>
            )}
            {initialLoadPending && (
                <div className="vc-splitview-status">Loading messages…</div>
            )}
            {!initialLoadPending && snapshot.error && !snapshot.messages.length && (
                <div className="vc-splitview-status vc-splitview-status-error">
                    Messages could not be loaded.
                    <button type="button" onClick={() => void ensureMessages(channelId)}>Retry</button>
                </div>
            )}
            {!initialLoadPending && snapshot.ready && !snapshot.messages.length && !snapshot.loading && (
                <div className="vc-splitview-status">No messages yet.</div>
            )}
            <UserProfileClickHandler
                channel={channel}
                messageListRef={messageListRef}
                messages={renderedMessages}
                style={{ height: initialLoadPending ? 0 : messageListHeight }}
            >
                {!initialLoadPending && renderedMessages.map((message, renderedIndex) => {
                    const messageIndex = startIndex + renderedIndex;
                    return (
                        <StableMessageRow
                            key={message.id}
                            canManageMessages={canManageMessages}
                            channel={channel}
                            compact={compact}
                            currentUserId={currentUserId}
                            message={message}
                            pane={pane}
                            previousMessage={visibleMessages[messageIndex - 1]}
                            registerRow={registerRow}
                            top={MESSAGE_LIST_PADDING_TOP + offsets[messageIndex]}
                        />
                    );
                })}
            </UserProfileClickHandler>
        </div>
    );
}

let memoizedMessageList: ComponentType<{ viewportKey: string; }> | undefined;

/** Skip unrelated parent renders; pane activation refreshes the viewport internally. */
export function StableMessageList(props: { viewportKey: string; }) {
    const MemoizedMessageList = memoizedMessageList ??= React.memo(MessageList);
    return <MemoizedMessageList {...props} />;
}
