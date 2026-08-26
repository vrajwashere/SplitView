/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ComponentDispatch, React } from "@webpack/common";

import { equalizeViewSizes, getLayoutState, setActivePane } from "../state/layoutStore";

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

function focusPrimaryComposer(): void {
    ComponentDispatch.dispatchToLastSubscribed("TEXTAREA_FOCUS");
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
    else focusSplitComposer(paneId);
}

export function ComposerShortcuts({ geometry }: { geometry: PaneShortcutGeometry; }) {
    const geometryRef = React.useRef(geometry);
    geometryRef.current = geometry;

    React.useEffect(() => {
        function onKeyDown(event: globalThis.KeyboardEvent): void {
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
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, []);

    return null;
}
