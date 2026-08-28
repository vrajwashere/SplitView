/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, SelectedChannelStore } from "@webpack/common";

import { isChannelAvailable, openAsPrimary } from "../discord/channel";
import { settings } from "../settings";
import { clearMessageViewportStates, forgetMessageViewportState } from "./messageViewportStore";
import { cancelScheduledPersistedState, flushPersistedState, loadPersistedState, schedulePersistedState } from "./persistence";
import type { LayoutNode, PersistedSplitState, PrimaryPaneRecord, SplitPaneRecord, SplitPlacement, SplitViewState } from "./types";

type Listener = () => void;
type LayoutPath = readonly (0 | 1)[];

const listeners = new Set<Listener>();

function createDefaultState(): SplitViewState {
    return {
        version: 3,
        layout: { type: "primary" },
        panes: {},
        primary: { tabs: [], activeTabId: null, previewTabId: null },
        activePaneId: null,
        hydrated: false
    };
}

let state = createDefaultState();
let drafts: Record<string, string> = {};
const stagedDrafts = new Map<string, string>();
const draftRecency = new Map<string, true>();
const draftRevisions = new Map<string, number>();
let liveSplitChannelIds = new Set<string>();
let initialized = false;

const MAXIMUM_RETAINED_DRAFTS = 500;
export const MAXIMUM_DRAFT_LENGTH = 100_000;
export const MAXIMUM_TABS_PER_PANE = 100;

function toPersistedState(value: SplitViewState): PersistedSplitState {
    const { hydrated: _hydrated, ...persisted } = value;
    return { ...persisted, drafts };
}

function publish(nextState: SplitViewState, persist = true): void {
    if (!state.hydrated && !nextState.hydrated) return;
    if (nextState.panes !== state.panes) {
        liveSplitChannelIds = new Set(Object.values(nextState.panes).map(pane => pane.channelId));
    }
    state = nextState;
    for (const listener of listeners) listener();

    if (persist && state.hydrated && settings.store.rememberLayout) {
        schedulePersistedState(toPersistedState(state));
    }
}

function bumpDraftRevision(channelId: string): void {
    draftRevisions.set(channelId, (draftRevisions.get(channelId) ?? 0) + 1);
}

function makeId(prefix: string): string {
    const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${randomId}`;
}

function firstPaneId(layout: LayoutNode): string | undefined {
    if (layout.type === "primary") return undefined;
    if (layout.type === "pane") return layout.paneId;
    return firstPaneId(layout.first) ?? firstPaneId(layout.second);
}

function collectPaneIds(layout: LayoutNode, paneIds: string[] = []): string[] {
    if (layout.type === "pane") paneIds.push(layout.paneId);
    else if (layout.type === "split") {
        collectPaneIds(layout.first, paneIds);
        collectPaneIds(layout.second, paneIds);
    }
    return paneIds;
}

function findNodePath(layout: LayoutNode, matches: (node: LayoutNode) => boolean, path: (0 | 1)[] = []): (0 | 1)[] | undefined {
    if (matches(layout)) return path;
    if (layout.type !== "split") return undefined;
    return findNodePath(layout.first, matches, [...path, 0])
        ?? findNodePath(layout.second, matches, [...path, 1]);
}

function getNodeAtPath(layout: LayoutNode, path: LayoutPath): LayoutNode | undefined {
    let node = layout;
    for (const branch of path) {
        if (node.type !== "split") return undefined;
        node = branch === 0 ? node.first : node.second;
    }
    return node;
}

function replaceNodeAtPath(layout: LayoutNode, path: LayoutPath, replacement: LayoutNode): LayoutNode {
    if (!path.length) return replacement;
    if (layout.type !== "split") return layout;

    const [branch, ...rest] = path;
    return branch === 0
        ? { ...layout, first: replaceNodeAtPath(layout.first, rest, replacement) }
        : { ...layout, second: replaceNodeAtPath(layout.second, rest, replacement) };
}

function pruneLayout(layout: LayoutNode, panes: Record<string, SplitPaneRecord>): LayoutNode | null {
    if (layout.type === "primary") return layout;
    if (layout.type === "pane") return panes[layout.paneId] ? layout : null;

    const first = pruneLayout(layout.first, panes);
    const second = pruneLayout(layout.second, panes);
    if (!first) return second;
    if (!second) return first;
    return { ...layout, first, second };
}

function createPane(channelId: string): SplitPaneRecord {
    const paneId = makeId("pane");
    const tabId = makeId("tab");
    return {
        id: paneId,
        channelId,
        tabs: [{ id: tabId, channelId }],
        activeTabId: tabId
    };
}

function findPaneForChannel(channelId: string): { paneId: string; tabId: string; } | undefined {
    for (const [paneId, pane] of Object.entries(state.panes)) {
        const tab = pane.tabs.find(candidate => candidate.channelId === channelId);
        if (tab) return { paneId, tabId: tab.id };
    }
    return undefined;
}

function insertOpenedPane(layout: LayoutNode, paneIds: string[], paneId: string): LayoutNode {
    const paneNode: LayoutNode = { type: "pane", paneId };
    if (!paneIds.length) {
        return {
            type: "split",
            direction: "vertical",
            ratio: 0.5,
            first: layout,
            second: paneNode
        };
    }

    // Preserve the complete first split, including any user-adjusted ratio,
    // while retaining the familiar two-across/one-below default progression.
    if (paneIds.length === 1) {
        return {
            type: "split",
            direction: "horizontal",
            ratio: 0.5,
            first: layout,
            second: paneNode
        };
    }

    const targetPaneId = state.activePaneId && paneIds.includes(state.activePaneId)
        ? state.activePaneId
        : paneIds.at(-1)!;
    const targetPath = findNodePath(layout, node => node.type === "pane" && node.paneId === targetPaneId);
    const targetNode = targetPath && getNodeAtPath(layout, targetPath);
    if (!targetPath || !targetNode) {
        return {
            type: "split",
            direction: "vertical",
            ratio: 0.5,
            first: layout,
            second: paneNode
        };
    }

    return replaceNodeAtPath(layout, targetPath, {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: targetNode,
        second: paneNode
    });
}

function addChannelTab(paneId: string, channelId: string): boolean {
    const pane = state.panes[paneId];
    if (!pane) return false;
    const existingTab = pane.tabs.find(tab => tab.channelId === channelId);
    if (!existingTab && pane.tabs.length >= MAXIMUM_TABS_PER_PANE) return false;
    const activeTabId = existingTab?.id ?? makeId("tab");
    const tabs = existingTab
        ? pane.tabs
        : [...pane.tabs, { id: activeTabId, channelId }];

    publish({
        ...state,
        panes: {
            ...state.panes,
            [paneId]: {
                ...pane,
                channelId,
                tabs,
                activeTabId
            }
        },
        activePaneId: paneId
    });
    return true;
}

function activateExistingChannel(channelId: string): boolean {
    const existing = findPaneForChannel(channelId);
    if (!existing) return false;
    activateTab(existing.paneId, existing.tabId);
    setActivePane(existing.paneId);
    return true;
}

function maximumSecondaryPaneCount(): number {
    return Math.max(1, settings.store.maximumPaneCount - 1);
}

export function getLayoutState(): SplitViewState {
    return state;
}

export function isLiveSplitChannel(channelId: string): boolean {
    return liveSplitChannelIds.has(channelId);
}

export function subscribeLayout(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useLayoutState(): SplitViewState {
    return React.useSyncExternalStore(subscribeLayout, getLayoutState, getLayoutState);
}

/** Tab selection does not change workspace geometry or its active-pane outline. */
export function useWorkspaceLayout(): Pick<SplitViewState, "layout" | "activePaneId"> {
    const getLayout = () => state.layout;
    const getActivePane = () => state.activePaneId;
    const layout = React.useSyncExternalStore(subscribeLayout, getLayout, getLayout);
    const activePaneId = React.useSyncExternalStore(subscribeLayout, getActivePane, getActivePane);
    return { layout, activePaneId };
}

export function getPaneState(paneId: string): SplitPaneRecord | undefined;
export function getPaneState(paneId: null): PrimaryPaneRecord;
export function getPaneState(paneId: string | null): SplitPaneRecord | PrimaryPaneRecord | undefined;
export function getPaneState(paneId: string | null): SplitPaneRecord | PrimaryPaneRecord | undefined {
    return paneId == null ? state.primary : state.panes[paneId];
}

export function usePaneState(paneId: string): SplitPaneRecord | undefined;
export function usePaneState(paneId: null): PrimaryPaneRecord;
export function usePaneState(paneId: string | null): SplitPaneRecord | PrimaryPaneRecord | undefined;
export function usePaneState(paneId: string | null): SplitPaneRecord | PrimaryPaneRecord | undefined {
    const getSnapshot = React.useCallback(() => getPaneState(paneId), [paneId]);
    return React.useSyncExternalStore(subscribeLayout, getSnapshot, getSnapshot);
}

export function useIsPaneActive(paneId: string): boolean {
    const getSnapshot = React.useCallback(() => state.activePaneId === paneId, [paneId]);
    return React.useSyncExternalStore(subscribeLayout, getSnapshot, getSnapshot);
}

export async function initializeLayout(): Promise<void> {
    if (initialized) return;
    initialized = true;

    const restored = settings.store.rememberLayout && settings.store.restorePanesAfterRestart
        ? await loadPersistedState()
        : null;

    const { drafts: restoredDrafts = {}, ...restoredState } = restored ?? {};
    drafts = restoredDrafts;
    stagedDrafts.clear();
    draftRevisions.clear();
    draftRecency.clear();
    for (const channelId of Object.keys(drafts)) draftRecency.set(channelId, true);

    publish({
        ...createDefaultState(),
        ...restoredState,
        hydrated: true
    }, false);
    syncPrimaryChannel();
}

/** Observe Discord's route without navigating or replacing kept tabs. */
export function syncPrimaryChannel(): void {
    if (!state.hydrated) return;
    const selectedId = SelectedChannelStore.getChannelId();
    const channelId = selectedId && isChannelAvailable(selectedId) ? selectedId : undefined;
    const { primary } = state;
    const existing = primary.tabs.find(tab => tab.channelId === channelId);
    if (existing) {
        if (primary.activeTabId !== existing.id) publish({ ...state, primary: { ...primary, activeTabId: existing.id } });
        return;
    }
    if (!channelId && primary.activeTabId == null) return;

    const tabs = primary.tabs.filter(tab => tab.id !== primary.previewTabId);
    if (primary.previewTabId) forgetMessageViewportState(primary.previewTabId);
    const preview = channelId ? { id: makeId("tab"), channelId } : null;
    // Reserve one extra, replaceable preview even when all kept slots are full.
    if (preview) tabs.push(preview);
    publish({ ...state, primary: { tabs, activeTabId: preview?.id ?? null, previewTabId: preview?.id ?? null } });
}

export function keepPrimaryTab(): boolean {
    const { primary } = state;
    if (!primary.activeTabId || primary.activeTabId !== primary.previewTabId || primary.tabs.length > MAXIMUM_TABS_PER_PANE) return false;
    publish({ ...state, primary: { ...primary, previewTabId: null } });
    return true;
}

export function canOpenPrimaryTab(channelId: string): boolean {
    const { primary } = state;
    const existing = primary.tabs.find(tab => tab.channelId === channelId);
    return existing
        ? existing.id !== primary.previewTabId || primary.tabs.length <= MAXIMUM_TABS_PER_PANE
        : primary.tabs.length < MAXIMUM_TABS_PER_PANE;
}

/** Adding explicitly also keeps the current preview so it cannot be lost. */
export function openPrimaryTab(channelId: string): boolean {
    if (!state.hydrated || !isChannelAvailable(channelId)) return false;
    syncPrimaryChannel();
    if (!canOpenPrimaryTab(channelId)) return false;
    const { primary } = state;
    const existing = primary.tabs.find(tab => tab.channelId === channelId);
    const tab = existing ?? { id: makeId("tab"), channelId };
    const tabs = existing ? primary.tabs : [...primary.tabs, tab];
    publish({
        ...state,
        primary: { tabs, activeTabId: tab.id, previewTabId: tabs.length <= MAXIMUM_TABS_PER_PANE ? null : primary.previewTabId },
        activePaneId: null
    });
    openAsPrimary(channelId);
    return true;
}

export function openChannel(channelId: string): boolean {
    if (!state.hydrated || !isChannelAvailable(channelId)) return false;
    if (activateExistingChannel(channelId)) return true;

    const paneIds = collectPaneIds(state.layout);
    if (paneIds.length >= maximumSecondaryPaneCount()) {
        const preferredPaneId = state.activePaneId ?? paneIds[0];
        const targetPaneId = [preferredPaneId, ...paneIds]
            .find((paneId, index, candidates) => candidates.indexOf(paneId) === index && state.panes[paneId]?.tabs.length < MAXIMUM_TABS_PER_PANE);
        return targetPaneId ? addChannelTab(targetPaneId, channelId) : false;
    }

    const pane = createPane(channelId);
    publish({
        ...state,
        layout: insertOpenedPane(state.layout, paneIds, pane.id),
        panes: { ...state.panes, [pane.id]: pane },
        activePaneId: pane.id
    });
    return true;
}

export function openChannelInPane(channelId: string, paneId: string | null): boolean {
    if (!state.hydrated || !isChannelAvailable(channelId)) return false;
    if (paneId == null) return openPrimaryTab(channelId);
    if (activateExistingChannel(channelId)) return true;
    return addChannelTab(paneId, channelId) || openChannel(channelId);
}

export function splitChannel(channelId: string, targetPaneId: string | null, placement: SplitPlacement): boolean {
    if (!state.hydrated || !isChannelAvailable(channelId)) return false;
    if (activateExistingChannel(channelId)) return true;

    const paneIds = collectPaneIds(state.layout);
    if (paneIds.length >= maximumSecondaryPaneCount()) {
        return openChannelInPane(channelId, targetPaneId ?? state.activePaneId ?? paneIds[0]);
    }

    const targetPath = targetPaneId == null
        ? findNodePath(state.layout, node => node.type === "primary")
        : findNodePath(state.layout, node => node.type === "pane" && node.paneId === targetPaneId);
    if (!targetPath) {
        return openChannel(channelId);
    }

    const targetNode = getNodeAtPath(state.layout, targetPath);
    if (!targetNode) return false;

    const pane = createPane(channelId);
    const paneNode: LayoutNode = { type: "pane", paneId: pane.id };
    const isBefore = placement === "left" || placement === "top";
    const direction = placement === "left" || placement === "right" ? "vertical" : "horizontal";
    const replacement: LayoutNode = {
        type: "split",
        direction,
        ratio: 0.5,
        first: isBefore ? paneNode : targetNode,
        second: isBefore ? targetNode : paneNode
    };

    publish({
        ...state,
        layout: replaceNodeAtPath(state.layout, targetPath, replacement),
        panes: { ...state.panes, [pane.id]: pane },
        activePaneId: pane.id
    });
    return true;
}

export function activateTab(paneId: string | null, tabId: string): void {
    const pane = getPaneState(paneId);
    const tab = pane?.tabs.find(candidate => candidate.id === tabId);
    if (!pane || !tab) return;
    if (paneId == null) {
        if (!isChannelAvailable(tab.channelId)) return;
        if (pane.activeTabId !== tabId || state.activePaneId !== null) {
            publish({ ...state, primary: { ...state.primary, activeTabId: tabId }, activePaneId: null });
        }
        // Never render a split message list or composer for the primary pane.
        if (SelectedChannelStore.getChannelId() !== tab.channelId) openAsPrimary(tab.channelId);
        return;
    }
    if (pane.activeTabId === tabId && state.activePaneId === paneId) return;

    publish({
        ...state,
        panes: {
            ...state.panes,
            [paneId]: { ...state.panes[paneId], channelId: tab.channelId, activeTabId: tab.id }
        },
        activePaneId: paneId
    });
}

export function closeTab(paneId: string | null, tabId: string): void {
    if (paneId == null) {
        const { primary } = state;
        const closedIndex = primary.tabs.findIndex(tab => tab.id === tabId);
        if (closedIndex < 0) return;
        // Discord always needs a main view. Closing its last kept tab unkeeps it.
        if (primary.tabs.length === 1 && primary.activeTabId === tabId) {
            if (primary.previewTabId !== tabId) publish({ ...state, primary: { ...primary, previewTabId: tabId } });
            return;
        }
        const tabs = primary.tabs.filter(tab => tab.id !== tabId);
        const nextTab = primary.activeTabId === tabId ? tabs[Math.min(closedIndex, tabs.length - 1)] : undefined;
        forgetMessageViewportState(tabId);
        publish({ ...state, primary: {
            tabs,
            activeTabId: nextTab?.id ?? (primary.activeTabId === tabId ? null : primary.activeTabId),
            previewTabId: primary.previewTabId === tabId ? null : primary.previewTabId
        } });
        if (nextTab) openAsPrimary(nextTab.channelId);
        return;
    }
    const pane = state.panes[paneId];
    if (!pane) return;
    const closedIndex = pane.tabs.findIndex(tab => tab.id === tabId);
    if (closedIndex < 0) return;
    if (pane.tabs.length === 1) {
        closePane(paneId);
        return;
    }

    forgetMessageViewportState(tabId);

    const tabs = pane.tabs.filter(tab => tab.id !== tabId);
    const activeTab = pane.activeTabId === tabId
        ? tabs[Math.min(closedIndex, tabs.length - 1)]
        : tabs.find(tab => tab.id === pane.activeTabId) ?? tabs[0];

    publish({
        ...state,
        panes: {
            ...state.panes,
            [paneId]: {
                ...pane,
                channelId: activeTab.channelId,
                tabs,
                activeTabId: activeTab.id
            }
        }
    });
}

function findTabSource(tabId: string) {
    if (state.primary.tabs.some(tab => tab.id === tabId)) return { paneId: null, pane: state.primary };
    const pane = Object.values(state.panes).find(candidate => candidate.tabs.some(tab => tab.id === tabId));
    return pane ? { paneId: pane.id, pane } : undefined;
}

export function canMoveTab(paneId: string | null, tabId: string): boolean {
    const target = getPaneState(paneId);
    const source = findTabSource(tabId);
    if (!target || !source) return false;
    if (source.paneId === paneId) return true;
    const tab = source.pane.tabs.find(tab => tab.id === tabId)!;
    if (paneId == null) {
        return isChannelAvailable(tab.channelId)
            && target.tabs.filter(candidate => candidate.channelId !== tab.channelId).length < MAXIMUM_TABS_PER_PANE;
    }
    return target.tabs.length < MAXIMUM_TABS_PER_PANE
        && !target.tabs.some(candidate => candidate.channelId === tab.channelId);
}

export function moveTab(paneId: string | null, tabId: string, targetTabId?: string, placement: "before" | "after" = "before"): boolean {
    if (tabId === targetTabId || !canMoveTab(paneId, tabId)) return false;
    const target = getPaneState(paneId)!;
    const { paneId: sourcePaneId, pane: source } = findTabSource(tabId)!;
    const sourceIndex = source.tabs.findIndex(tab => tab.id === tabId);
    const tab = source.tabs[sourceIndex];
    const tabs = target.tabs.filter(candidate => candidate.id !== tabId);
    const targetIndex = targetTabId == null ? tabs.length : tabs.findIndex(candidate => candidate.id === targetTabId);
    if (targetIndex < 0) return false;
    tabs.splice(targetIndex + (targetTabId != null && placement === "after" ? 1 : 0), 0, tab);

    const movingAcrossPanes = sourcePaneId !== paneId;
    const panes = { ...state.panes };
    let { primary } = state;
    if (paneId == null) {
        // A split can show the current native channel too. Merge that duplicate
        // while retaining the dragged tab's identity and viewport cache.
        const duplicate = tabs.find(candidate => candidate.channelId === tab.channelId && candidate.id !== tabId);
        if (duplicate) {
            tabs.splice(tabs.indexOf(duplicate), 1);
            forgetMessageViewportState(duplicate.id);
        }
        primary = {
            tabs,
            activeTabId: movingAcrossPanes ? tab.id : primary.activeTabId,
            previewTabId: movingAcrossPanes || (primary.previewTabId === tabId && tabs.length <= MAXIMUM_TABS_PER_PANE)
                ? null : primary.previewTabId
        };
    } else {
        panes[paneId] = {
            ...state.panes[paneId], tabs,
            activeTabId: movingAcrossPanes ? tab.id : target.activeTabId,
            channelId: movingAcrossPanes ? tab.channelId : state.panes[paneId].channelId
        } as SplitPaneRecord;
    }
    if (movingAcrossPanes) {
        const remainingTabs = source.tabs.filter(candidate => candidate.id !== tabId);
        if (sourcePaneId == null) {
            // The last native tab can move, but Discord's main view cannot close.
            const fallback = { id: makeId("tab"), channelId: tab.channelId };
            const activeTab = remainingTabs.find(candidate => candidate.id === source.activeTabId)
                ?? remainingTabs[Math.min(sourceIndex, remainingTabs.length - 1)]
                ?? fallback;
            primary = {
                tabs: remainingTabs.length ? remainingTabs : [fallback],
                activeTabId: source.activeTabId == null ? null : activeTab.id,
                previewTabId: !remainingTabs.length ? fallback.id : primary.previewTabId === tabId ? null : primary.previewTabId
            };
        } else if (remainingTabs.length) {
            const activeTab = remainingTabs.find(candidate => candidate.id === source.activeTabId)
                ?? remainingTabs[Math.min(sourceIndex, remainingTabs.length - 1)];
            panes[sourcePaneId] = { ...state.panes[sourcePaneId], tabs: remainingTabs, activeTabId: activeTab.id, channelId: activeTab.channelId };
        } else {
            // Moving is not closing: retain the tab ID, viewport cache and draft.
            delete panes[sourcePaneId];
        }
    }

    const previousPrimaryChannel = state.primary.tabs.find(candidate => candidate.id === state.primary.activeTabId)?.channelId;
    publish({
        ...state,
        layout: movingAcrossPanes ? pruneLayout(state.layout, panes) ?? { type: "primary" } : state.layout,
        panes,
        primary,
        activePaneId: movingAcrossPanes ? paneId : state.activePaneId
    });
    const primaryChannel = primary.tabs.find(candidate => candidate.id === primary.activeTabId)?.channelId;
    if (primaryChannel && (primaryChannel !== previousPrimaryChannel || (movingAcrossPanes && paneId == null))) openAsPrimary(primaryChannel);
    return true;
}

export function swapPanePositions(paneId: string | null, targetPaneId: string | null): boolean {
    if (paneId === targetPaneId || !getPaneState(paneId) || !getPaneState(targetPaneId)) return false;
    const sourcePath = findNodePath(state.layout, node => paneId == null
        ? node.type === "primary"
        : node.type === "pane" && node.paneId === paneId);
    const targetPath = findNodePath(state.layout, node => targetPaneId == null
        ? node.type === "primary"
        : node.type === "pane" && node.paneId === targetPaneId);
    if (!sourcePath || !targetPath) return false;
    const sourceNode = getNodeAtPath(state.layout, sourcePath)!;
    const targetNode = getNodeAtPath(state.layout, targetPath)!;

    // Swap leaf positions, not pane records, so mounted panes keep their tabs,
    // composers and message lists while the existing split sizes stay intact.
    const layout = replaceNodeAtPath(state.layout, sourcePath, targetNode);
    publish({
        ...state,
        layout: replaceNodeAtPath(layout, targetPath, sourceNode)
    });
    return true;
}

export function closePane(paneId: string): void {
    const closedPane = state.panes[paneId];
    if (!closedPane) return;
    for (const tab of closedPane.tabs) forgetMessageViewportState(tab.id);
    const panes = { ...state.panes };
    delete panes[paneId];
    const layout = pruneLayout(state.layout, panes) ?? { type: "primary" };

    publish({
        ...state,
        layout,
        panes,
        activePaneId: state.activePaneId === paneId ? firstPaneId(layout) ?? null : state.activePaneId
    });
}

export function closeAllPanes(): void {
    clearMessageViewportStates();
    publish({ ...state, layout: { type: "primary" }, panes: {}, activePaneId: null });
}

export function setActivePane(paneId: string | null): void {
    if (state.activePaneId === paneId || (paneId != null && !state.panes[paneId])) return;
    publish({ ...state, activePaneId: paneId });
}

export function setSplitRatio(path: LayoutPath, ratio: number): void {
    const split = getNodeAtPath(state.layout, path);
    if (split?.type !== "split") return;
    const clampedRatio = Math.min(0.9, Math.max(0.1, ratio));
    if (split.ratio === clampedRatio) return;
    publish({
        ...state,
        layout: replaceNodeAtPath(state.layout, path, { ...split, ratio: clampedRatio })
    });
}

export function equalizeViewSizes(): void {
    function equalize(node: LayoutNode): { layout: LayoutNode; viewCount: number; } {
        if (node.type !== "split") return { layout: node, viewCount: 1 };

        const first = equalize(node.first);
        const second = equalize(node.second);
        const viewCount = first.viewCount + second.viewCount;
        // Weight each branch by its views so nested splits get equal areas,
        // including the primary chat, instead of resetting every split to 50%.
        const ratio = first.viewCount / viewCount;
        const layout = node.ratio === ratio && node.first === first.layout && node.second === second.layout
            ? node
            : { ...node, ratio, first: first.layout, second: second.layout };
        return { layout, viewCount };
    }

    const { layout } = equalize(state.layout);
    if (layout !== state.layout) publish({ ...state, layout });
}

export function getDraft(channelId: string): string {
    return stagedDrafts.has(channelId) ? stagedDrafts.get(channelId)! : drafts[channelId] ?? "";
}

export function getDraftRevision(channelId: string): number {
    return draftRevisions.get(channelId) ?? 0;
}

/** Stage a keystroke-only update without notifying React or scheduling storage. */
export function stageDraft(channelId: string, draft: string): void {
    if (!state.hydrated) return;
    const boundedDraft = draft.slice(0, MAXIMUM_DRAFT_LENGTH);
    if (getDraft(channelId) !== boundedDraft) bumpDraftRevision(channelId);
    stagedDrafts.set(channelId, boundedDraft);
}

export function commitStagedDraft(channelId: string): void {
    if (!stagedDrafts.has(channelId)) return;
    const draft = stagedDrafts.get(channelId)!;
    stagedDrafts.delete(channelId);
    setDraftValue(channelId, draft, false);
}

export function flushStagedDrafts(): void {
    for (const channelId of [...stagedDrafts.keys()]) commitStagedDraft(channelId);
}

export function setDraft(channelId: string, draft: string): void {
    setDraftValue(channelId, draft, true);
}

function setDraftValue(channelId: string, draft: string, revise: boolean): void {
    if (!state.hydrated) return;
    const boundedDraft = draft.slice(0, MAXIMUM_DRAFT_LENGTH);
    const previousDraft = getDraft(channelId);
    stagedDrafts.delete(channelId);
    if (drafts[channelId] === boundedDraft) return;
    if (revise && previousDraft !== boundedDraft) bumpDraftRevision(channelId);
    if (boundedDraft) {
        drafts[channelId] = boundedDraft;
        draftRecency.delete(channelId);
        draftRecency.set(channelId, true);
    } else {
        delete drafts[channelId];
        draftRecency.delete(channelId);
    }
    while (draftRecency.size > MAXIMUM_RETAINED_DRAFTS) {
        const oldestChannelId = draftRecency.keys().next().value;
        if (oldestChannelId == null) break;
        draftRecency.delete(oldestChannelId);
        delete drafts[oldestChannelId];
    }

    if (state.hydrated && settings.store.rememberLayout) {
        schedulePersistedState(toPersistedState(state));
    }
}

export function clearDraftAtRevision(channelId: string, revision: number): boolean {
    if (getDraftRevision(channelId) !== revision) return false;
    setDraft(channelId, "");
    return true;
}

export function pruneUnavailableChannels(isAvailable: (channelId: string) => boolean): void {
    const primaryTabs = state.primary.tabs.filter(tab => isAvailable(tab.channelId));
    const primaryChanged = primaryTabs.length !== state.primary.tabs.length;
    const primary = primaryChanged ? {
        tabs: primaryTabs,
        activeTabId: primaryTabs.some(tab => tab.id === state.primary.activeTabId) ? state.primary.activeTabId : null,
        previewTabId: primaryTabs.some(tab => tab.id === state.primary.previewTabId) ? state.primary.previewTabId : null
    } : state.primary;
    let panesChanged = false;
    const panes = Object.fromEntries(
        Object.entries(state.panes).flatMap(([paneId, pane]) => {
            const tabs = pane.tabs.filter(tab => isAvailable(tab.channelId));
            for (const tab of pane.tabs) {
                if (!tabs.some(candidate => candidate.id === tab.id)) forgetMessageViewportState(tab.id);
            }
            if (!tabs.length) {
                panesChanged = true;
                return [];
            }
            const activeTab = tabs.find(tab => tab.id === pane.activeTabId) ?? tabs[0];
            panesChanged ||= tabs.length !== pane.tabs.length || activeTab.id !== pane.activeTabId;
            return [[paneId, {
                ...pane,
                channelId: activeTab.channelId,
                tabs,
                activeTabId: activeTab.id
            } satisfies SplitPaneRecord]];
        })
    );
    const layout = pruneLayout(state.layout, panes) ?? { type: "primary" };

    if (!primaryChanged && !panesChanged && Object.keys(panes).length === Object.keys(state.panes).length) return;
    publish({
        ...state,
        layout,
        panes,
        primary,
        activePaneId: state.activePaneId && panes[state.activePaneId] ? state.activePaneId : firstPaneId(layout) ?? null
    });
}

export function flushLayoutPersistence(): Promise<void> {
    if (!state.hydrated || !settings.store.rememberLayout) {
        cancelScheduledPersistedState();
        return Promise.resolve();
    }
    return flushPersistedState(toPersistedState(state));
}
