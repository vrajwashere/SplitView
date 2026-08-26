/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ComponentDispatch, React } from "@webpack/common";

import { activateTab, equalizeViewSizes, getLayoutState, getPaneState, setActivePane } from "../state/layoutStore";

export interface PaneShortcutRect {
    height: number;
    width: number;
    x: number;
    y: number;
}

export interface PaneShortcutGeometry {
    panes: Array<{ paneId: string; rect: PaneShortcutRect; }>;
    primary: PaneShortcutRect;
}

interface PaneShortcutTarget {
    paneId: string | null;
    rect: PaneShortcutRect;
}

const splitComposers = new Map<string, HTMLTextAreaElement>();
const paneContainers = new Map<string | null, HTMLElement>();
let primaryComposer: HTMLElement | null = null;

export function usePaneFocusRef(paneId: string | null) {
    return React.useCallback((pane: HTMLElement | null) => {
        if (pane) paneContainers.set(paneId, pane);
        else {
            paneContainers.delete(paneId);
            if (paneId == null) primaryComposer = null;
        }
    }, [paneId]);
}

/** Capture the native editor through the patched chat's React focus event. */
export function rememberPrimaryComposer(target: EventTarget | null): void {
    if (target instanceof HTMLElement && target.isContentEditable && target.getAttribute("role") === "textbox") {
        primaryComposer = target;
    }
}

function getPaneElement(paneId: string | null): HTMLElement | undefined {
    return paneContainers.get(paneId);
}

function focusPaneContainer(paneId: string | null): void {
    getPaneElement(paneId)?.focus({ preventScroll: true });
}

export function registerSplitComposer(paneId: string, composer: HTMLTextAreaElement | null): void {
    if (composer) splitComposers.set(paneId, composer);
    else splitComposers.delete(paneId);
}

export function focusSplitComposer(paneId = getLayoutState().activePaneId): boolean {
    const composer = paneId ? splitComposers.get(paneId) : undefined;
    if (!composer?.isConnected || composer.disabled) return false;

    composer.focus({ preventScroll: true });
    const caret = composer.value.length;
    composer.setSelectionRange(caret, caret);
    return true;
}

export function focusPrimaryComposer(): void {
    const pane = getPaneElement(null);
    if (primaryComposer?.isConnected && pane?.contains(primaryComposer)) {
        primaryComposer.focus({ preventScroll: true });
    } else {
        // Let Discord resolve its own editor when a channel change replaces it.
        ComponentDispatch.dispatchToLastSubscribed("TEXTAREA_FOCUS");
    }
    // A read-only/unmounted editor must not leave focus in the previous split.
    if (pane?.isConnected && !pane.contains(document.activeElement)) focusPaneContainer(null);
}

function orderedTargets(geometry: PaneShortcutGeometry): PaneShortcutTarget[] {
    const splitTargets = geometry.panes
        .map(({ paneId, rect }) => ({ paneId, rect }))
        .sort((first, second) => first.rect.y - second.rect.y || first.rect.x - second.rect.x);
    return [{ paneId: null, rect: geometry.primary }, ...splitTargets];
}

function center(rect: PaneShortcutRect): { x: number; y: number; } {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function directionalTarget(
    targets: PaneShortcutTarget[],
    activePaneId: string | null,
    direction: "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp"
): PaneShortcutTarget | undefined {
    const current = targets.find(target => target.paneId === activePaneId) ?? targets[0];
    const currentCenter = center(current.rect);
    const vertical = direction === "ArrowDown" || direction === "ArrowUp";
    const forward = direction === "ArrowDown" || direction === "ArrowRight";

    return targets
        .filter(target => target !== current)
        .map(target => {
            const targetCenter = center(target.rect);
            const primaryDistance = vertical
                ? targetCenter.y - currentCenter.y
                : targetCenter.x - currentCenter.x;
            const crossDistance = vertical
                ? Math.abs(targetCenter.x - currentCenter.x)
                : Math.abs(targetCenter.y - currentCenter.y);
            return { primaryDistance, crossDistance, target };
        })
        .filter(candidate => forward ? candidate.primaryDistance > 0.001 : candidate.primaryDistance < -0.001)
        .sort((first, second) =>
            Math.abs(first.primaryDistance) - Math.abs(second.primaryDistance)
            || first.crossDistance - second.crossDistance
        )[0]?.target;
}

function activatePane(paneId: string | null): void {
    setActivePane(paneId);
    if (paneId == null) focusPrimaryComposer();
    else if (!focusSplitComposer(paneId)) focusPaneContainer(paneId);
}

export function ComposerShortcuts({ geometry }: { geometry: PaneShortcutGeometry; }) {
    const geometryRef = React.useRef(geometry);
    geometryRef.current = geometry;

    React.useEffect(() => {
        let focusFrame: number | undefined;

        function onKeyDown(event: globalThis.KeyboardEvent): void {
            if (event.defaultPrevented || event.isComposing) return;
            if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                // Capture before the native editor consumes Ctrl+Arrow to move the caret.
                // Scope to the workspace so dialogs and the sidebar keep their shortcuts.
                const { target } = event;
                if (!(target instanceof Element) || target.closest('[role="dialog"], [role="menu"], [aria-modal="true"]')) return;
                const sourcePane = Array.from(paneContainers.values()).find(pane => pane.contains(target));
                if (!sourcePane && !(target === document.body && focusFrame != null)) return;
                // Clicking non-focusable chat content changes the selected pane
                // without moving DOM focus out of the previous pane's editor.
                const { activePaneId: paneId } = getLayoutState();
                const paneElement = getPaneElement(paneId);
                if (!paneElement) return;
                const pane = getPaneState(paneId);
                if (!pane?.activeTabId || pane.tabs.length < 2) return;
                const index = pane.tabs.findIndex(tab => tab.id === pane.activeTabId);
                if (index < 0) return;
                const offset = event.key === "ArrowLeft" ? -1 : 1;
                const nextTab = pane.tabs[(index + offset + pane.tabs.length) % pane.tabs.length];
                event.preventDefault();
                event.stopImmediatePropagation();
                // Keep repeat key events on a stable element while navigation
                // replaces the native editor or the split's controlled textarea.
                focusPaneContainer(paneId);
                activateTab(paneId, nextTab.id);

                // Navigation can replace the focused editor. Wait for its refs
                // to attach, without stealing focus if the user leaves the pane.
                if (focusFrame != null) cancelAnimationFrame(focusFrame);
                focusFrame = requestAnimationFrame(() => {
                    focusFrame = requestAnimationFrame(() => {
                        focusFrame = undefined;
                        if (!paneElement.isConnected || getLayoutState().activePaneId !== paneId || getPaneState(paneId)?.activeTabId !== nextTab.id) return;
                        const focused = document.activeElement;
                        if (focused && focused !== document.body && !paneElement.contains(focused)) return;
                        if (paneId == null) {
                            focusPrimaryComposer();
                        } else if (!focusSplitComposer(paneId)) {
                            focusPaneContainer(paneId);
                        }
                    });
                });
                return;
            }
            if (event.repeat || event.metaKey) return;

            let handled = false;
            const targets = orderedTargets(geometryRef.current);
            const { activePaneId } = getLayoutState();
            if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === "Space") {
                if (targets.length > 1) {
                    const currentIndex = Math.max(0, targets.findIndex(target => target.paneId === activePaneId));
                    activatePane(targets[(currentIndex + 1) % targets.length].paneId);
                    handled = true;
                }
            } else if (
                event.ctrlKey
                && event.shiftKey
                && !event.altKey
                && ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)
            ) {
                const target = directionalTarget(
                    targets,
                    activePaneId,
                    event.key as "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp"
                );
                if (target) {
                    activatePane(target.paneId);
                    handled = true;
                }
            } else if (event.ctrlKey && event.altKey && !event.shiftKey && event.code === "Digit0") {
                if (targets.length > 1) {
                    equalizeViewSizes();
                    handled = true;
                }
            } else if (event.ctrlKey && event.altKey && !event.shiftKey && /^Digit[1-4]$/.test(event.code)) {
                const targetIndex = Number(event.code.at(-1)) - 1;
                const target = targets[targetIndex];
                if (target) {
                    activatePane(target.paneId);
                    handled = true;
                }
            }

            if (!handled) return;
            event.preventDefault();
            event.stopPropagation();
        }

        window.addEventListener("keydown", onKeyDown, true);
        return () => {
            if (focusFrame != null) cancelAnimationFrame(focusFrame);
            window.removeEventListener("keydown", onKeyDown, true);
        };
    }, []);

    return null;
}
