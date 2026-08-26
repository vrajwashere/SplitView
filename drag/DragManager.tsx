/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel } from "@vencord/discord-types";
import { React, ReactDOM } from "@webpack/common";
import type { CSSProperties, DOMAttributes } from "react";

import { getChannelHeaderDetails, isChannelAvailable } from "../discord/channel";
import { settings } from "../settings";
import { getLayoutState, MAXIMUM_TABS_PER_PANE, openChannelInPane, splitChannel } from "../state/layoutStore";
import type { SplitPlacement } from "../state/types";

const DRAG_THRESHOLD = 8;
const EDGE_ZONE_RATIO = 0.28;

export interface NormalizedDragRect {
    height: number;
    width: number;
    x: number;
    y: number;
}

export interface DragWorkspaceGeometry {
    panes: Array<{ paneId: string; rect: NormalizedDragRect; }>;
    primary: NormalizedDragRect;
}

interface ScreenRect {
    bottom: number;
    height: number;
    left: number;
    right: number;
    top: number;
    width: number;
}

type DropAction = {
    kind: "tab";
    paneId: string;
    rect: ScreenRect;
} | {
    kind: "split";
    placement: SplitPlacement;
    rect: ScreenRect;
    targetPaneId: string | null;
};

interface DragState {
    action?: DropAction;
    active: boolean;
    channel: Channel;
    pointerId: number;
    sourceId: string;
    startX: number;
    startY: number;
    x: number;
    y: number;
}

type WorkspaceProvider = () => {
    geometry: DragWorkspaceGeometry;
    rect: DOMRect;
} | undefined;

let dragState: DragState | null = null;
let workspaceProvider: WorkspaceProvider | undefined;
let dragWorkspace: ReturnType<WorkspaceProvider>;
let suppressClickUntil = 0;
let suppressClickChannelId: string | undefined;
const listeners = new Set<() => void>();

function publish(nextState: DragState | null): void {
    dragState = nextState;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function useDragState(): DragState | null {
    return React.useSyncExternalStore(subscribe, () => dragState);
}

export function registerDragWorkspace(provider: WorkspaceProvider): () => void {
    workspaceProvider = provider;
    return () => {
        if (workspaceProvider === provider) workspaceProvider = undefined;
    };
}

function normalizedToScreen(rect: NormalizedDragRect, workspace: DOMRect): ScreenRect {
    const left = workspace.left + rect.x * workspace.width;
    const top = workspace.top + rect.y * workspace.height;
    const width = rect.width * workspace.width;
    const height = rect.height * workspace.height;
    return { bottom: top + height, height, left, right: left + width, top, width };
}

function splitPreview(rect: ScreenRect, placement: SplitPlacement): ScreenRect {
    if (placement === "left") return { ...rect, right: rect.left + rect.width / 2, width: rect.width / 2 };
    if (placement === "right") return {
        ...rect,
        left: rect.left + rect.width / 2,
        width: rect.width / 2
    };
    if (placement === "top") return { ...rect, bottom: rect.top + rect.height / 2, height: rect.height / 2 };
    return {
        ...rect,
        height: rect.height / 2,
        top: rect.top + rect.height / 2
    };
}

function closestEdge(rect: ScreenRect, x: number, y: number): SplitPlacement | undefined {
    const distances: Array<[SplitPlacement, number]> = [
        ["left", (x - rect.left) / rect.width],
        ["right", (rect.right - x) / rect.width],
        ["top", (y - rect.top) / rect.height],
        ["bottom", (rect.bottom - y) / rect.height]
    ];
    distances.sort((first, second) => first[1] - second[1]);
    return distances[0][1] <= EDGE_ZONE_RATIO ? distances[0][0] : undefined;
}

function containsPoint(rect: ScreenRect, x: number, y: number): boolean {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function getDropAction(x: number, y: number): DropAction | undefined {
    const workspace = dragWorkspace;
    if (!workspace || workspace.rect.width <= 0 || workspace.rect.height <= 0) return;

    const state = getLayoutState();
    const paneCount = Object.keys(state.panes).length;
    const primary = normalizedToScreen(workspace.geometry.primary, workspace.rect);

    if (!paneCount) {
        const targetWidth = Math.min(320, Math.max(180, primary.width * 0.36));
        if (x < primary.right - targetWidth || x > primary.right || y < primary.top || y > primary.bottom) return;
        return {
            kind: "split",
            placement: "right",
            rect: splitPreview(primary, "right"),
            targetPaneId: null
        };
    }

    const leaves = [
        { paneId: null, rect: primary },
        ...workspace.geometry.panes.map(pane => ({
            paneId: pane.paneId,
            rect: normalizedToScreen(pane.rect, workspace.rect)
        }))
    ];
    const leaf = leaves.find(candidate => containsPoint(candidate.rect, x, y));
    if (!leaf) return;

    const canAddPane = paneCount < Math.max(1, settings.store.maximumPaneCount - 1);
    const placement = canAddPane ? closestEdge(leaf.rect, x, y) : undefined;
    if (placement) {
        return {
            kind: "split",
            placement,
            rect: splitPreview(leaf.rect, placement),
            targetPaneId: leaf.paneId
        };
    }
    if (leaf.paneId && state.panes[leaf.paneId]?.tabs.length < MAXIMUM_TABS_PER_PANE) {
        return { kind: "tab", paneId: leaf.paneId, rect: leaf.rect };
    }
}

function cancelDrag(): void {
    dragWorkspace = undefined;
    publish(null);
}

function finishDrag(sourceId: string, pointerId: number): boolean {
    const current = dragState;
    if (!current || current.sourceId !== sourceId || current.pointerId !== pointerId) return false;

    const { action, active, channel } = current;
    if (active) {
        suppressClickUntil = performance.now() + 350;
        suppressClickChannelId = channel.id;
    }
    cancelDrag();

    if (action?.kind === "tab") openChannelInPane(channel.id, action.paneId);
    else if (action?.kind === "split") splitChannel(channel.id, action.targetPaneId, action.placement);
    return active;
}

function targetStyle(rect: ScreenRect): CSSProperties {
    return {
        height: rect.height,
        left: rect.left,
        top: rect.top,
        width: rect.width
    };
}

function SplitIcon({ horizontal }: { horizontal: boolean; }) {
    return horizontal ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm1 2v6h14V5H5Zm0 8v6h14v-6H5Z" />
        </svg>
    ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm1 2v14h6V5H5Zm8 0v14h6V5h-6Z" />
        </svg>
    );
}

export function DragLayer() {
    const state = useDragState();
    const listening = state != null;

    React.useLayoutEffect(() => {
        if (!listening) return;

        let moveFrame: number | undefined;
        let pendingMove: { active: boolean; pointerId: number; x: number; y: number; } | undefined;

        const publishPendingMove = () => {
            moveFrame = undefined;
            const pending = pendingMove;
            pendingMove = undefined;
            const current = dragState;
            if (!pending || !current || current.pointerId !== pending.pointerId) return;
            publish({
                ...current,
                active: pending.active,
                action: pending.active ? getDropAction(pending.x, pending.y) : undefined,
                x: pending.x,
                y: pending.y
            });
        };
        const onPointerMove = (event: globalThis.PointerEvent) => {
            const current = dragState;
            if (!current || current.pointerId !== event.pointerId) return;

            const active = current.active || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= DRAG_THRESHOLD;
            pendingMove = { active, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
            if (moveFrame == null) moveFrame = requestAnimationFrame(publishPendingMove);
            if (active) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        const onPointerUp = (event: globalThis.PointerEvent) => {
            const current = dragState;
            if (!current || current.pointerId !== event.pointerId) return;
            if (moveFrame != null) cancelAnimationFrame(moveFrame);
            moveFrame = undefined;
            pendingMove = {
                active: current.active || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= DRAG_THRESHOLD,
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY
            };
            publishPendingMove();
            if (!finishDrag(current.sourceId, event.pointerId)) return;
            event.preventDefault();
            event.stopPropagation();
        };
        const onPointerCancel = (event: globalThis.PointerEvent) => {
            if (dragState?.pointerId === event.pointerId) cancelDrag();
        };

        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key !== "Escape" || !dragState?.active) return;
            suppressClickUntil = performance.now() + 350;
            suppressClickChannelId = dragState.channel.id;
            event.preventDefault();
            cancelDrag();
        };
        window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
        window.addEventListener("pointerup", onPointerUp, true);
        window.addEventListener("pointercancel", onPointerCancel, true);
        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("blur", cancelDrag);
        return () => {
            if (moveFrame != null) cancelAnimationFrame(moveFrame);
            window.removeEventListener("pointermove", onPointerMove, true);
            window.removeEventListener("pointerup", onPointerUp, true);
            window.removeEventListener("pointercancel", onPointerCancel, true);
            window.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("blur", cancelDrag);
        };
    }, [listening]);

    if (!state?.active) return null;

    const details = getChannelHeaderDetails(state.channel);
    const { action } = state;
    const horizontal = action?.kind === "split" && (action.placement === "top" || action.placement === "bottom");
    return ReactDOM.createPortal(
        <div className="vc-splitview-drag-layer" aria-hidden="true">
            {action && (
                <div className="vc-splitview-drop-target vc-splitview-drop-target-active" style={targetStyle(action.rect)}>
                    <div className="vc-splitview-drop-target-icon">
                        <SplitIcon horizontal={horizontal} />
                    </div>
                    <div className="vc-splitview-drop-target-title">
                        {action.kind === "tab" ? "Open as a tab" : `Split ${action.placement}`}
                    </div>
                    <div className="vc-splitview-drop-target-hint">
                        {action.kind === "tab" ? "Release in this pane" : "Release to create a new view"}
                    </div>
                </div>
            )}
            <div
                className="vc-splitview-drag-ghost"
                style={{ transform: `translate3d(${state.x + 14}px, ${state.y + 14}px, 0)` }}
            >
                {details.iconUrl
                    ? <img className="vc-splitview-drag-ghost-icon" src={details.iconUrl} alt="" />
                    : <span className="vc-splitview-drag-ghost-fallback">#</span>}
                <div className="vc-splitview-drag-ghost-text">
                    <div className="vc-splitview-drag-ghost-title">{details.title}</div>
                    <div className="vc-splitview-drag-ghost-subtitle">
                        Drop in a pane center for a tab, or on an edge to split
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
}

type ChannelDragProps = Pick<DOMAttributes<HTMLElement>, "onClickCapture" | "onDragStartCapture" | "onPointerDownCapture">;
const channelDragProps = new WeakMap<Channel, ChannelDragProps>();

export function getChannelDragProps(channel: Channel): ChannelDragProps {
    const cached = channelDragProps.get(channel);
    if (cached) return cached;

    const props: ChannelDragProps = {
        onPointerDownCapture(event) {
            if (
                !settings.store.enableDragToSplit
                || event.button !== 0
                || event.isPrimary === false
                || !isChannelAvailable(channel.id)
            ) return;

            dragWorkspace = workspaceProvider?.();
            publish({
                active: false,
                channel,
                pointerId: event.pointerId,
                sourceId: channel.id,
                startX: event.clientX,
                startY: event.clientY,
                x: event.clientX,
                y: event.clientY
            });
        },
        onClickCapture(event) {
            if (suppressClickChannelId !== channel.id || performance.now() >= suppressClickUntil) return;
            event.preventDefault();
            event.stopPropagation();
        },
        onDragStartCapture(event) {
            if (dragState?.sourceId === channel.id) event.preventDefault();
        }
    };
    channelDragProps.set(channel, props);
    return props;
}
