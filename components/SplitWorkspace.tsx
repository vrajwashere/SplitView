/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { React } from "@webpack/common";
import type { CSSProperties, FocusEventHandler, PointerEventHandler, ReactElement } from "react";

import { DragLayer, registerDragWorkspace } from "../drag/DragManager";
import { WorkspaceDragLayer } from "../drag/WorkspaceDrag";
import { ComposerShortcuts, rememberPrimaryComposer, usePaneFocusRef } from "../keyboard/ComposerFocusManager";
import { closeTab, getPaneState, setActivePane, setSplitRatio, useWorkspaceLayout } from "../state/layoutStore";
import type { LayoutNode } from "../state/types";
import { Divider, type LayoutRect } from "./Divider";
import { StablePaneTabs } from "./PaneTabs";
import { StableSplitPane } from "./SplitPane";

interface PanePlacement {
    paneId: string;
    rect: LayoutRect;
}

interface DividerPlacement {
    node: Extract<LayoutNode, { type: "split"; }>;
    path: readonly (0 | 1)[];
    ratio: number;
    rect: LayoutRect;
}

interface RatioPreview {
    pathKey: string;
    ratio: number;
}

interface LayoutGeometry {
    dividers: DividerPlacement[];
    panes: PanePlacement[];
    primary: LayoutRect;
}

export interface PrimaryChatProps {
    className?: string;
    onFocusCapture?: FocusEventHandler<HTMLElement>;
    onPointerDownCapture?: PointerEventHandler<HTMLElement>;
}

const FULL_RECT: LayoutRect = { height: 1, width: 1, x: 0, y: 0 };

function calculateLayoutGeometry(layout: LayoutNode, preview: RatioPreview | null): LayoutGeometry {
    const panes: PanePlacement[] = [];
    const dividers: DividerPlacement[] = [];
    let primary = FULL_RECT;

    function visit(node: LayoutNode, rect: LayoutRect, path: (0 | 1)[]) {
        if (node.type === "primary") {
            primary = rect;
            return;
        }
        if (node.type === "pane") {
            panes.push({ paneId: node.paneId, rect });
            return;
        }

        const ratio = preview?.pathKey === path.join("-") ? preview.ratio : node.ratio;
        dividers.push({ node, path, ratio, rect });
        if (node.direction === "vertical") {
            const firstWidth = rect.width * ratio;
            visit(node.first, { ...rect, width: firstWidth }, [...path, 0]);
            visit(node.second, {
                ...rect,
                width: rect.width - firstWidth,
                x: rect.x + firstWidth
            }, [...path, 1]);
            return;
        }

        const firstHeight = rect.height * ratio;
        visit(node.first, { ...rect, height: firstHeight }, [...path, 0]);
        visit(node.second, {
            ...rect,
            height: rect.height - firstHeight,
            y: rect.y + firstHeight
        }, [...path, 1]);
    }

    visit(layout, FULL_RECT, []);
    return { dividers, panes, primary };
}

function rectStyle(rect: LayoutRect): CSSProperties {
    return {
        height: `${rect.height * 100}%`,
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`
    };
}

function rectTransform(from: LayoutRect, to: LayoutRect): string {
    const translateX = (to.x - from.x) / from.width * 100;
    const translateY = (to.y - from.y) / from.height * 100;
    const scaleX = to.width / from.width;
    const scaleY = to.height / from.height;

    if (
        Math.abs(translateX) < 0.0001
        && Math.abs(translateY) < 0.0001
        && Math.abs(scaleX - 1) < 0.0001
        && Math.abs(scaleY - 1) < 0.0001
    ) return "none";

    return `translate(${translateX.toFixed(4)}%, ${translateY.toFixed(4)}%) scale(${scaleX.toFixed(6)}, ${scaleY.toFixed(6)})`;
}

export function SplitWorkspace({ primary }: { primary: ReactElement<PrimaryChatProps>; }) {
    const { activePaneId, layout } = useWorkspaceLayout();
    const hostRef = React.useRef<HTMLDivElement>(null);
    const workspaceRef = React.useRef<HTMLDivElement>(null);
    const primaryFocusRef = usePaneFocusRef(null);
    const [ratioPreview, setRatioPreview] = React.useState<RatioPreview | null>(null);
    const committedGeometry = React.useMemo(() => calculateLayoutGeometry(layout, null), [layout]);
    const geometry = React.useMemo(
        () => ratioPreview == null ? committedGeometry : calculateLayoutGeometry(layout, ratioPreview),
        [committedGeometry, layout, ratioPreview]
    );
    const geometryRef = React.useRef(geometry);
    geometryRef.current = geometry;
    // Visual swaps only change styles. Moving existing scroll containers in DOM
    // order can reset their browser scroll position while virtualization still
    // holds the old offset, leaving a blank pane until the next scroll event.
    const panePlacements = React.useMemo(
        () => [...geometry.panes].sort((first, second) => first.paneId.localeCompare(second.paneId)),
        [geometry.panes]
    );
    const active = layout.type !== "primary";
    const previewRatio = React.useCallback((path: readonly (0 | 1)[], ratio: number | null) => {
        const pathKey = path.join("-");
        setRatioPreview(current => ratio == null
            ? (current?.pathKey === pathKey ? null : current)
            : (current?.pathKey === pathKey && current.ratio === ratio ? current : { pathKey, ratio })
        );
    }, []);
    const commitRatio = React.useCallback((path: readonly (0 | 1)[], ratio: number) => {
        setRatioPreview(null);
        setSplitRatio(path, ratio);
    }, []);

    React.useLayoutEffect(() => registerDragWorkspace(() => {
        const rect = hostRef.current?.getBoundingClientRect();
        if (!rect) return;
        return { geometry: geometryRef.current, rect };
    }), []);

    const hostStyle = {
        "--vc-splitview-primary-left": `${committedGeometry.primary.x * 100}%`,
        "--vc-splitview-primary-top": `${committedGeometry.primary.y * 100}%`,
        "--vc-splitview-primary-width": `${committedGeometry.primary.width * 100}%`,
        "--vc-splitview-primary-height": `${committedGeometry.primary.height * 100}%`,
        "--vc-splitview-primary-resize-transform": ratioPreview == null
            ? "none"
            : rectTransform(committedGeometry.primary, geometry.primary)
    } as CSSProperties;
    const selectedRect = activePaneId == null
        ? geometry.primary
        : geometry.panes.find(pane => pane.paneId === activePaneId)?.rect;
    // Keep the enormous native chat subtree referentially stable while the
    // resize preview updates. Its geometry is driven by host CSS properties.
    const primaryChat = React.useMemo(() => React.cloneElement(primary, {
        className: [primary.props.className, "vc-splitview-primary"].filter(Boolean).join(" "),
        onFocusCapture(event) {
            primary.props.onFocusCapture?.(event);
            rememberPrimaryComposer(event.target);
            setActivePane(null);
        },
        onPointerDownCapture(event) {
            primary.props.onPointerDownCapture?.(event);
            setActivePane(null);
        }
    }), [primary]);

    return (
        <div
            ref={hostRef}
            className={`vc-splitview-host${active ? " vc-splitview-host-active" : ""}${ratioPreview ? " vc-splitview-host-resizing" : ""}`}
            style={hostStyle}
        >
            <div
                ref={primaryFocusRef}
                className="vc-splitview-primary-slot"
                tabIndex={-1}
                onFocusCapture={() => setActivePane(null)}
                onPointerDownCapture={() => setActivePane(null)}
                onKeyDown={event => {
                    if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
                    const pane = getPaneState(null);
                    if (!pane.activeTabId) return;
                    if (event.key.toLowerCase() === "w") {
                        event.preventDefault();
                        event.stopPropagation();
                        closeTab(null, pane.activeTabId);
                    }
                }}
            >
                <ErrorBoundary message="SplitView could not render main chat tabs.">
                    <StablePaneTabs paneId={null} />
                </ErrorBoundary>
                {primaryChat}
            </div>
            <ComposerShortcuts geometry={geometry} />
            <DragLayer />
            <WorkspaceDragLayer hostRef={hostRef} geometry={geometry} />
            {active && selectedRect && (
                <div
                    className="vc-splitview-active-pane-outline"
                    style={rectStyle(selectedRect)}
                    aria-hidden="true"
                />
            )}
            {active && (
                <div className="vc-splitview-secondary-root" role="region" aria-label="SplitView secondary channels">
                    <ErrorBoundary message="SplitView could not render its secondary workspace.">
                        <div className="vc-splitview-layout" ref={workspaceRef}>
                            {panePlacements.map(({ paneId, rect }) => (
                                <div
                                    key={paneId}
                                    className="vc-splitview-pane-slot"
                                    data-vc-splitview-pane-id={paneId}
                                    style={rectStyle(rect)}
                                >
                                    <ErrorBoundary message="SplitView could not render this channel.">
                                        <StableSplitPane paneId={paneId} />
                                    </ErrorBoundary>
                                </div>
                            ))}
                            {geometry.dividers.map(({ node, path, ratio, rect }) => (
                                <Divider
                                    key={path.join("-") || "root"}
                                    direction={node.direction}
                                    first={node.first}
                                    path={path}
                                    ratio={ratio}
                                    rect={rect}
                                    second={node.second}
                                    workspaceRef={workspaceRef}
                                    onRatioCommit={commitRatio}
                                    onRatioPreview={previewRatio}
                                />
                            ))}
                        </div>
                    </ErrorBoundary>
                </div>
            )}
        </div>
    );
}
