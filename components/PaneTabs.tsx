/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, GuildStore, React, UserStore, useStateFromStores } from "@webpack/common";
import type { ComponentType, DragEvent, KeyboardEvent, MouseEvent } from "react";

import { getChannel, getChannelHeaderDetails } from "../discord/channel";
import { prewarmChannelMessages } from "../discord/messages";
import { beginWorkspaceDrag } from "../drag/WorkspaceDrag";
import { settings } from "../settings";
import { activateTab, closePane, closeTab, keepPrimaryTab, MAXIMUM_TABS_PER_PANE, openPrimaryTab, usePaneState } from "../state/layoutStore";
import type { PaneTab } from "../state/types";

interface PaneTabButtonProps {
    paneId: string | null;
    tab: PaneTab;
    active: boolean;
    preview: boolean;
    canClose: boolean;
}

function PaneTabButton({ paneId, tab, active, preview, canClose }: PaneTabButtonProps) {
    const [dragging, setDragging] = React.useState(false);
    const prewarmTimerRef = React.useRef<number | undefined>(undefined);
    const details = useStateFromStores(
        [ChannelStore, GuildStore, UserStore],
        () => {
            const channel = getChannel(tab.channelId);
            return channel ? getChannelHeaderDetails(channel) : undefined;
        },
        [tab.channelId],
        (previous, next) => previous?.title === next?.title
            && previous?.subtitle === next?.subtitle
            && previous?.iconUrl === next?.iconUrl
    );

    function cancelPrewarm() {
        if (prewarmTimerRef.current != null) clearTimeout(prewarmTimerRef.current);
        prewarmTimerRef.current = undefined;
    }

    function prewarmSoon() {
        if (active || prewarmTimerRef.current != null) return;
        prewarmTimerRef.current = window.setTimeout(() => {
            prewarmTimerRef.current = undefined;
            prewarmChannelMessages(tab.channelId);
        }, 75);
    }

    function prewarmNow() {
        cancelPrewarm();
        if (!active) prewarmChannelMessages(tab.channelId);
    }

    React.useEffect(() => cancelPrewarm, []);

    if (!details) return null;

    function close(event: MouseEvent) {
        event.preventDefault();
        event.stopPropagation();
        if (canClose) closeTab(paneId, tab.id);
    }

    function onDragStart(event: DragEvent<HTMLDivElement>) {
        beginWorkspaceDrag(event, { kind: "tab", paneId, tabId: tab.id });
        setDragging(true);
    }

    return (
        <div
            className={`vc-splitview-tab${active ? " vc-splitview-tab-active" : ""}${preview ? " vc-splitview-tab-preview" : ""}${dragging ? " vc-splitview-tab-dragging" : ""}`}
            role="tab"
            aria-selected={active}
            data-vc-splitview-tab-id={tab.id}
            tabIndex={active ? 0 : -1}
            draggable
            title={`${details.subtitle ? `${details.title} — ${details.subtitle}` : details.title}${preview ? " — Preview: click + to keep this tab before browsing elsewhere" : ""}`}
            onClick={() => activateTab(paneId, tab.id)}
            onFocus={prewarmNow}
            onPointerDown={prewarmNow}
            onPointerEnter={prewarmSoon}
            onPointerLeave={cancelPrewarm}
            onDoubleClick={() => {
                if (preview) keepPrimaryTab();
            }}
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                if (event.target !== event.currentTarget) return;
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                activateTab(paneId, tab.id);
            }}
            onAuxClick={event => {
                if (event.button === 1) close(event);
            }}
            onDragStart={onDragStart}
            onDragEnd={() => setDragging(false)}
        >
            {details.iconUrl
                ? <img className="vc-splitview-tab-icon" src={details.iconUrl} alt="" draggable={false} />
                : <span className="vc-splitview-tab-icon-fallback" aria-hidden="true">#</span>}
            <span className="vc-splitview-tab-title">{details.title}</span>
            <button
                type="button"
                className="vc-splitview-tab-close"
                aria-label={`Close ${details.title} tab`}
                title="Close tab"
                disabled={!canClose}
                onClick={close}
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4l5.3 5.3-5.3 5.3a1 1 0 0 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12l5.3-5.3a1 1 0 1 0-1.4-1.4L12 10.6 6.7 5.3Z" />
                </svg>
            </button>
        </div>
    );
}

let memoizedPaneTabButton: ComponentType<PaneTabButtonProps> | undefined;

function StablePaneTabButton(props: PaneTabButtonProps) {
    const MemoizedPaneTabButton = memoizedPaneTabButton ??= React.memo(PaneTabButton);
    return <MemoizedPaneTabButton {...props} />;
}

export function PaneTabs({ paneId }: { paneId: string | null; }) {
    const pane = usePaneState(paneId);
    const { showPaneTabs } = settings.use(["showPaneTabs"]);
    const navigationRef = React.useRef<HTMLDivElement>(null);
    const stripRef = React.useRef<HTMLDivElement>(null);
    const revealActiveTabRef = React.useRef<(() => void) | undefined>(undefined);
    const [overflow, setOverflow] = React.useState({ overflowing: false, left: false, right: false });

    React.useLayoutEffect(() => {
        const navigation = navigationRef.current;
        const strip = stripRef.current;
        if (!navigation || !strip) return;
        let frame: number | undefined;

        function updateOverflow() {
            // Compare with the full navigation width, including the arrows,
            // so the controls disappear again as soon as all tabs would fit.
            const overflowing = strip!.scrollWidth > navigation!.clientWidth + 1;
            const left = overflowing && strip!.scrollLeft > 1;
            const right = overflowing && strip!.scrollLeft + strip!.clientWidth < strip!.scrollWidth - 1;
            setOverflow(current => current.overflowing === overflowing && current.left === left && current.right === right
                ? current
                : { overflowing, left, right });
        }

        function revealActiveTab() {
            if (frame != null) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                frame = undefined;
                const activeTab = strip!.querySelector<HTMLElement>('[aria-selected="true"]');
                if (activeTab) {
                    const tabRect = activeTab.getBoundingClientRect();
                    const stripRect = strip!.getBoundingClientRect();
                    if (!activeTab.previousElementSibling) strip!.scrollLeft = 0;
                    else if (!activeTab.nextElementSibling) strip!.scrollLeft = strip!.scrollWidth;
                    else if (tabRect.left < stripRect.left + 12) strip!.scrollLeft += tabRect.left - stripRect.left - 12;
                    else if (tabRect.right > stripRect.right - 12) strip!.scrollLeft += tabRect.right - stripRect.right + 12;
                }
                updateOverflow();
            });
        }

        function onWheel(event: globalThis.WheelEvent) {
            if (event.ctrlKey || event.shiftKey || event.deltaX !== 0 || strip!.scrollWidth <= strip!.clientWidth + 1) return;
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip!.clientWidth : 1;
            strip!.scrollLeft += event.deltaY * unit;
            event.preventDefault();
        }

        const observer = new ResizeObserver(revealActiveTab);
        observer.observe(navigation);
        observer.observe(strip);
        strip.addEventListener("scroll", updateOverflow, { passive: true });
        strip.addEventListener("wheel", onWheel, { passive: false });
        revealActiveTabRef.current = revealActiveTab;
        revealActiveTab();
        return () => {
            revealActiveTabRef.current = undefined;
            observer.disconnect();
            if (frame != null) cancelAnimationFrame(frame);
            strip.removeEventListener("scroll", updateOverflow);
            strip.removeEventListener("wheel", onWheel);
        };
    }, [pane?.tabs, showPaneTabs]);

    React.useLayoutEffect(() => {
        revealActiveTabRef.current?.();
    }, [pane?.activeTabId]);

    React.useEffect(() => {
        if (paneId != null || !pane?.activeTabId || pane.tabs.length < 2) return;
        const activeIndex = pane.tabs.findIndex(tab => tab.id === pane.activeTabId);
        if (activeIndex < 0) return;
        const neighborIds = new Set([
            pane.tabs[(activeIndex - 1 + pane.tabs.length) % pane.tabs.length].channelId,
            pane.tabs[(activeIndex + 1) % pane.tabs.length].channelId
        ]);
        const timer = setTimeout(() => {
            for (const channelId of neighborIds) prewarmChannelMessages(channelId);
        }, 350);
        return () => clearTimeout(timer);
    }, [pane?.activeTabId, pane?.tabs, paneId]);

    if (!pane) return null;

    const tabs = showPaneTabs
        ? pane.tabs
        : pane.tabs.filter(tab => tab.id === pane.activeTabId);
    const previewTabId = "previewTabId" in pane ? pane.previewTabId : null;
    const activeChannelId = pane.tabs.find(tab => tab.id === pane.activeTabId)?.channelId;
    const canKeep = pane.activeTabId != null && pane.activeTabId === previewTabId && pane.tabs.length <= MAXIMUM_TABS_PER_PANE;

    return (
        <div className="vc-splitview-tabbar" data-vc-splitview-tabbar={paneId ?? "primary"}>
            <div
                className="vc-splitview-pane-drag-handle"
                draggable
                title="Drag to swap this pane, including all its tabs, with another view"
                aria-label="Drag to move this pane and all its tabs"
                onDragStart={event => beginWorkspaceDrag(event, { kind: "pane", paneId })}
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M9 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM9 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM9 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />
                </svg>
            </div>
            <div ref={navigationRef} className="vc-splitview-tab-navigation">
                {overflow.overflowing && (
                    <button
                        type="button"
                        className="vc-splitview-tab-scroll-button"
                        aria-label="Scroll tabs left"
                        title="Scroll tabs left"
                        disabled={!overflow.left}
                        onClick={() => {
                            const strip = stripRef.current;
                            if (strip) strip.scrollLeft -= Math.max(112, strip.clientWidth * 0.8);
                        }}
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="m14 6-6 6 6 6" /></svg>
                    </button>
                )}
                <div
                    ref={stripRef}
                    className={`vc-splitview-tabs${overflow.left ? " vc-splitview-tabs-overflow-left" : ""}${overflow.right ? " vc-splitview-tabs-overflow-right" : ""}`}
                    role="tablist"
                    aria-label={paneId == null ? "Main chat channels" : "Split view channels"}
                    onKeyDown={event => {
                        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.target !== document.activeElement) return;
                        const current = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="tab"]') : null;
                        if (!current || event.target !== current) return;
                        const currentIndex = tabs.findIndex(tab => tab.id === current.dataset.vcSplitviewTabId);
                        let nextIndex: number;
                        if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
                        else if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
                        else if (event.key === "Home") nextIndex = 0;
                        else if (event.key === "End") nextIndex = tabs.length - 1;
                        else return;
                        event.preventDefault();
                        event.stopPropagation();
                        stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus({ preventScroll: true });
                        activateTab(paneId, tabs[nextIndex].id);
                    }}
                >
                    {tabs.map(tab => (
                        <StablePaneTabButton
                            key={tab.id}
                            paneId={paneId}
                            tab={tab}
                            active={tab.id === pane.activeTabId}
                            preview={tab.id === previewTabId}
                            canClose={paneId != null || pane.tabs.length > 1 || tab.id !== previewTabId}
                        />
                    ))}
                </div>
                {overflow.overflowing && (
                    <button
                        type="button"
                        className="vc-splitview-tab-scroll-button"
                        aria-label="Scroll tabs right"
                        title="Scroll tabs right"
                        disabled={!overflow.right}
                        onClick={() => {
                            const strip = stripRef.current;
                            if (strip) strip.scrollLeft += Math.max(112, strip.clientWidth * 0.8);
                        }}
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="m10 6 6 6-6 6" /></svg>
                    </button>
                )}
            </div>
            {paneId == null ? (
                <button
                    type="button"
                    className="vc-splitview-keep-tab-button"
                    aria-label="Keep current channel as a main chat tab"
                    title={pane.tabs.length > MAXIMUM_TABS_PER_PANE
                        ? "Tab limit reached — close a kept tab first"
                        : canKeep
                            ? "Keep this tab, then browse to another channel or DM. You can also drag channels here."
                            : "Tab kept — browse to another channel or DM, or drag one here to add it"}
                    disabled={!canKeep}
                    onClick={() => keepPrimaryTab()}
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d={canKeep ? "M12 5v14M5 12h14" : "m5 12 4 4L19 6"} />
                    </svg>
                </button>
            ) : <><button
                type="button"
                className="vc-splitview-open-primary-button"
                aria-label="Open channel in main chat"
                title="Open channel in main chat"
                onClick={() => {
                    if (activeChannelId) openPrimaryTab(activeChannelId);
                }}
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M14 3a1 1 0 1 0 0 2h3.59l-7.3 7.3a1 1 0 0 0 1.42 1.4L19 6.42V10a1 1 0 1 0 2 0V4a1 1 0 0 0-1-1h-6Z" />
                    <path fill="currentColor" d="M5 5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 1 0-2 0v5H5V7h5a1 1 0 1 0 0-2H5Z" />
                </svg>
            </button>
            <button
                type="button"
                className="vc-splitview-close-split-button"
                aria-label="Close this split pane"
                title="Close pane"
                onClick={() => closePane(paneId)}
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4l5.3 5.3-5.3 5.3a1 1 0 0 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12l5.3-5.3a1 1 0 1 0-1.4-1.4L12 10.6 6.7 5.3Z" />
                </svg>
            </button></>}
        </div>
    );
}

let memoizedPaneTabs: ComponentType<{ paneId: string | null; }> | undefined;

/** Avoid rerendering the tab strip when only pane focus or composer state changes. */
export function StablePaneTabs(props: { paneId: string | null; }) {
    const MemoizedPaneTabs = memoizedPaneTabs ??= React.memo(PaneTabs);
    return <MemoizedPaneTabs {...props} />;
}
