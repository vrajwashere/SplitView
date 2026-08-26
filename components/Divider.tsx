/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";

import { settings } from "../settings";
import type { LayoutNode, SplitDirection } from "../state/types";

export interface LayoutRect {
    height: number;
    width: number;
    x: number;
    y: number;
}

interface DividerProps {
    direction: SplitDirection;
    first: LayoutNode;
    path: readonly (0 | 1)[];
    ratio: number;
    rect: LayoutRect;
    second: LayoutNode;
    workspaceRef: RefObject<HTMLDivElement | null>;
    onRatioCommit(path: readonly (0 | 1)[], ratio: number): void;
    onRatioPreview(path: readonly (0 | 1)[], ratio: number | null): void;
}

interface DragGeometry {
    axisLength: number;
    axisStart: number;
    maximumRatio: number;
    minimumRatio: number;
}

const MINIMUM_PANE_HEIGHT = 180;

function minimumSpan(node: LayoutNode, direction: SplitDirection): number {
    const leafMinimum = direction === "vertical" ? settings.store.minimumPaneWidth : MINIMUM_PANE_HEIGHT;
    if (node.type !== "split") return leafMinimum;
    const first = minimumSpan(node.first, direction);
    const second = minimumSpan(node.second, direction);
    return node.direction === direction ? first + second : Math.max(first, second);
}

function ratioBounds(firstMinimum: number, secondMinimum: number, axisLength: number): [number, number] {
    if (firstMinimum + secondMinimum <= axisLength) {
        return [
            Math.max(0.1, firstMinimum / axisLength),
            Math.min(0.9, 1 - secondMinimum / axisLength)
        ];
    }

    const preferred = firstMinimum / (firstMinimum + secondMinimum);
    return [Math.max(0.1, preferred - 0.05), Math.min(0.9, preferred + 0.05)];
}

export function Divider({ direction, first, onRatioCommit, onRatioPreview, path, ratio, rect, second, workspaceRef }: DividerProps) {
    const dragGeometryRef = useRef<DragGeometry | undefined>(undefined);
    const pendingRatioRef = useRef<number | undefined>(undefined);
    const previewFrameRef = useRef<number | undefined>(undefined);
    const [ariaBounds, setAriaBounds] = useState<[number, number]>([0.1, 0.9]);
    const [dragging, setDragging] = useState(false);
    const vertical = direction === "vertical";
    const position = vertical
        ? rect.x + rect.width * ratio
        : rect.y + rect.height * ratio;
    const style: CSSProperties = vertical
        ? { height: `${rect.height * 100}%`, left: `${position * 100}%`, top: `${rect.y * 100}%` }
        : { left: `${rect.x * 100}%`, top: `${position * 100}%`, width: `${rect.width * 100}%` };

    useEffect(() => () => {
        if (previewFrameRef.current != null) cancelAnimationFrame(previewFrameRef.current);
    }, []);

    function measureResizeGeometry(): DragGeometry | undefined {
        const workspace = workspaceRef.current;
        if (!workspace) return;
        const workspaceRect = workspace.getBoundingClientRect();
        const workspaceAxisLength = vertical ? workspaceRect.width : workspaceRect.height;
        const axisLength = workspaceAxisLength * (vertical ? rect.width : rect.height);
        if (axisLength <= 0) return;
        const axisStart = (vertical ? workspaceRect.left : workspaceRect.top)
            + workspaceAxisLength * (vertical ? rect.x : rect.y);
        const [minimumRatio, maximumRatio] = ratioBounds(
            minimumSpan(first, direction),
            minimumSpan(second, direction),
            axisLength
        );

        return { axisLength, axisStart, minimumRatio, maximumRatio };
    }

    function updateAriaBounds(geometry: DragGeometry | undefined): void {
        if (!geometry) return;
        setAriaBounds(previous => (
            previous[0] === geometry.minimumRatio && previous[1] === geometry.maximumRatio
                ? previous
                : [geometry.minimumRatio, geometry.maximumRatio]
        ));
    }

    function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
        if (event.button !== 0) return;

        const geometry = measureResizeGeometry();
        if (!geometry) return;

        dragGeometryRef.current = geometry;
        pendingRatioRef.current = ratio;
        updateAriaBounds(geometry);
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        event.preventDefault();
    }

    function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
        const geometry = dragGeometryRef.current;
        if (!geometry || !event.currentTarget.hasPointerCapture(event.pointerId)) return;

        const pointerPosition = vertical ? event.clientX : event.clientY;
        const nextRatio = (pointerPosition - geometry.axisStart) / geometry.axisLength;
        pendingRatioRef.current = Math.min(geometry.maximumRatio, Math.max(geometry.minimumRatio, nextRatio));
        if (previewFrameRef.current != null) return;
        previewFrameRef.current = requestAnimationFrame(() => {
            previewFrameRef.current = undefined;
            if (pendingRatioRef.current != null) onRatioPreview(path, pendingRatioRef.current);
        });
    }

    function finishDrag(event: ReactPointerEvent<HTMLDivElement>) {
        if (!dragGeometryRef.current) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (previewFrameRef.current != null) cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = undefined;
        const finalRatio = pendingRatioRef.current;
        if (event.type === "pointerup" && finalRatio != null) onRatioCommit(path, finalRatio);
        else onRatioPreview(path, null);
        setDragging(false);
        dragGeometryRef.current = undefined;
        pendingRatioRef.current = undefined;
    }

    function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        const decrementKey = vertical ? "ArrowLeft" : "ArrowUp";
        const incrementKey = vertical ? "ArrowRight" : "ArrowDown";
        if (event.key !== decrementKey && event.key !== incrementKey) return;
        event.preventDefault();
        const geometry = measureResizeGeometry();
        if (!geometry) return;
        updateAriaBounds(geometry);
        const nextRatio = ratio + (event.key === incrementKey ? 0.02 : -0.02);
        onRatioCommit(path, Math.min(geometry.maximumRatio, Math.max(geometry.minimumRatio, nextRatio)));
    }

    return (
        <div
            className={`vc-splitview-divider vc-splitview-divider-${direction}${dragging ? " vc-splitview-divider-dragging" : ""}`}
            style={style}
            role="separator"
            tabIndex={0}
            aria-label={`Resize ${vertical ? "left and right" : "top and bottom"} split panes`}
            aria-orientation={vertical ? "vertical" : "horizontal"}
            aria-valuemin={Math.round(ariaBounds[0] * 100)}
            aria-valuemax={Math.round(ariaBounds[1] * 100)}
            aria-valuenow={Math.round(ratio * 100)}
            onFocus={() => updateAriaBounds(measureResizeGeometry())}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
        />
    );
}
