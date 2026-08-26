/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, ReactDOM } from "@webpack/common";
import type { DragEvent as ReactDragEvent, RefObject } from "react";

import { focusPrimaryComposer, focusSplitComposer } from "../keyboard/ComposerFocusManager";
import { canMoveTab, getLayoutState, getPaneState, moveTab, swapPanePositions } from "../state/layoutStore";
import type { DragWorkspaceGeometry } from "./DragManager";

const WORKSPACE_DRAG_TYPE = "application/x-vencord-splitview-workspace";

type DragSource = { kind: "tab"; paneId: string | null; tabId: string; } | { kind: "pane"; paneId: string | null; };
type PreviewRect = Pick<DOMRect, "height" | "left" | "top" | "width">;
type DropTarget = {
    kind: "tab";
    paneId: string | null;
    tabId?: string;
    placement: "before" | "after";
    rect: PreviewRect;
    marker: boolean;
} | {
    kind: "pane";
    paneId: string | null;
    rect: PreviewRect;
};

let dragSource: DragSource | null = null;

export function beginWorkspaceDrag(event: ReactDragEvent<HTMLElement>, source: DragSource): void {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(WORKSPACE_DRAG_TYPE, JSON.stringify(source));
    dragSource = source;
    if (source.kind === "pane") {
        const header = event.currentTarget.closest<HTMLElement>(".vc-splitview-tabbar");
        if (header) event.dataTransfer.setDragImage(header, 16, 24);
    }
}

export function WorkspaceDragLayer({ hostRef, geometry }: {
    hostRef: RefObject<HTMLDivElement | null>;
    geometry: DragWorkspaceGeometry;
}) {
    const geometryRef = React.useRef(geometry);
    geometryRef.current = geometry;
    const [preview, setPreview] = React.useState<DropTarget | null>(null);

    React.useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        let focusFrame: number | undefined;

        function getDropTarget(event: globalThis.DragEvent, source: DragSource): DropTarget | null {
            const sourcePane = getPaneState(source.paneId);
            if (!sourcePane || (source.kind === "tab" && !sourcePane.tabs.some(tab => tab.id === source.tabId))) return null;
            const workspace = host!.getBoundingClientRect();
            const currentGeometry = geometryRef.current;
            const leaves = [{ paneId: null, rect: currentGeometry.primary }, ...currentGeometry.panes];
            const leaf = leaves.map(({ paneId, rect }) => ({
                paneId,
                rect: {
                    left: workspace.left + rect.x * workspace.width,
                    top: workspace.top + rect.y * workspace.height,
                    width: rect.width * workspace.width,
                    height: rect.height * workspace.height
                }
            })).find(({ rect }) => event.clientX >= rect.left && event.clientX < rect.left + rect.width
                && event.clientY >= rect.top && event.clientY < rect.top + rect.height);
            if (!leaf) return null;
            if (source.kind === "pane") {
                return leaf.paneId === source.paneId ? null : { kind: "pane", ...leaf };
            }
            if (!canMoveTab(leaf.paneId, source.tabId)) return null;

            const targetElement = event.target instanceof Element
                ? event.target.closest<HTMLElement>("[data-vc-splitview-tab-id]")
                : null;
            const tabId = targetElement?.dataset.vcSplitviewTabId;
            if (tabId && getPaneState(leaf.paneId)?.tabs.some(tab => tab.id === tabId)) {
                if (tabId === source.tabId) return null;
                const rect = targetElement!.getBoundingClientRect();
                const placement = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
                return {
                    kind: "tab", paneId: leaf.paneId, tabId, placement, marker: true,
                    rect: { top: rect.top, height: rect.height, left: (placement === "before" ? rect.left : rect.right) - 2, width: 4 }
                };
            }
            return { kind: "tab", paneId: leaf.paneId, placement: "after", rect: leaf.rect, marker: false };
        }

        function onDragOver(event: globalThis.DragEvent): void {
            if (!dragSource || !event.dataTransfer?.types.includes(WORKSPACE_DRAG_TYPE)) return;
            const target = getDropTarget(event, dragSource);
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = target ? "move" : "none";
            setPreview(target);
        }

        function clearDrag(): void {
            dragSource = null;
            setPreview(null);
        }

        function onDrop(event: globalThis.DragEvent): void {
            const source = dragSource;
            if (!source || !event.dataTransfer?.types.includes(WORKSPACE_DRAG_TYPE)) return;
            const target = getDropTarget(event, source);
            event.preventDefault();
            event.stopPropagation();
            clearDrag();
            if (!target) return;

            const moved = source.kind === "pane" && target.kind === "pane"
                ? swapPanePositions(source.paneId, target.paneId)
                : source.kind === "tab" && target.kind === "tab"
                    && moveTab(target.paneId, source.tabId, target.tabId, target.placement);
            if (!moved) return;
            const paneId = source.kind === "pane" ? source.paneId : target.paneId;
            if (focusFrame != null) cancelAnimationFrame(focusFrame);
            focusFrame = requestAnimationFrame(() => {
                if (getLayoutState().activePaneId !== paneId) return;
                if (paneId == null) focusPrimaryComposer();
                else focusSplitComposer(paneId);
            });
        }

        function onDragLeave(event: globalThis.DragEvent): void {
            if (!(event.relatedTarget instanceof Node) || !host!.contains(event.relatedTarget)) setPreview(null);
        }

        function onKeyDown(event: globalThis.KeyboardEvent): void {
            if (event.key === "Escape" && dragSource) clearDrag();
        }

        host.addEventListener("dragover", onDragOver, true);
        host.addEventListener("drop", onDrop, true);
        host.addEventListener("dragleave", onDragLeave);
        window.addEventListener("dragend", clearDrag);
        window.addEventListener("drop", clearDrag);
        window.addEventListener("blur", clearDrag);
        window.addEventListener("keydown", onKeyDown, true);
        return () => {
            dragSource = null;
            if (focusFrame != null) cancelAnimationFrame(focusFrame);
            host.removeEventListener("dragover", onDragOver, true);
            host.removeEventListener("drop", onDrop, true);
            host.removeEventListener("dragleave", onDragLeave);
            window.removeEventListener("dragend", clearDrag);
            window.removeEventListener("drop", clearDrag);
            window.removeEventListener("blur", clearDrag);
            window.removeEventListener("keydown", onKeyDown, true);
        };
    }, [hostRef]);

    if (!preview) return null;
    return ReactDOM.createPortal(
        <div className="vc-splitview-drag-layer" aria-hidden="true">
            {preview.kind === "tab" && preview.marker ? (
                <div className="vc-splitview-tab-drop-marker" style={preview.rect} />
            ) : (
                <div className="vc-splitview-drop-target vc-splitview-drop-target-active" style={preview.rect}>
                    <div className="vc-splitview-drop-target-title">
                        {preview.kind === "pane" ? "Swap view positions" : preview.paneId == null ? "Move to main chat tabs" : "Move tab here"}
                    </div>
                    <div className="vc-splitview-drop-target-hint">
                        {preview.kind === "pane" ? "All tabs stay with their pane" : preview.paneId == null ? "Uses Discord's native navigation" : "Release to add at the end of this pane's tabs"}
                    </div>
                </div>
            )}
        </div>,
        document.body
    );
}
