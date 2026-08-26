/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { logger } from "../logger";
import type { LayoutNode, PersistedSplitState, PrimaryPaneRecord, SplitPaneRecord } from "./types";

const MAXIMUM_DRAFT_COUNT = 500;
const MAXIMUM_DRAFT_LENGTH = 100_000;
const MAXIMUM_IDENTIFIER_LENGTH = 256;
const MAXIMUM_LAYOUT_DEPTH = 16;
const MAXIMUM_LAYOUT_NODES = 63;
const MAXIMUM_PANE_COUNT = 32;
const MAXIMUM_TABS_PER_PANE = 100;

interface LayoutParseContext {
    nodeCount: number;
    seen: Set<object>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRatio(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0.1 && value <= 0.9;
}

function isIdentifier(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= MAXIMUM_IDENTIFIER_LENGTH;
}

function parseLayoutNode(value: unknown, allowPrimary: boolean, context: LayoutParseContext, depth = 0): LayoutNode | undefined {
    if (!isRecord(value) || depth > MAXIMUM_LAYOUT_DEPTH || context.seen.has(value)) return undefined;
    context.seen.add(value);
    context.nodeCount++;
    if (context.nodeCount > MAXIMUM_LAYOUT_NODES) return undefined;

    if (allowPrimary && value.type === "primary") return { type: "primary" };

    if (value.type === "pane" && isIdentifier(value.paneId)) {
        return { type: "pane", paneId: value.paneId };
    }

    if (value.type !== "split" || (value.direction !== "horizontal" && value.direction !== "vertical") || !isRatio(value.ratio)) {
        return undefined;
    }

    const first = parseLayoutNode(value.first, allowPrimary, context, depth + 1);
    const second = parseLayoutNode(value.second, allowPrimary, context, depth + 1);
    if (!first || !second) return undefined;

    return {
        type: "split",
        direction: value.direction,
        ratio: value.ratio,
        first,
        second
    };
}

function countPrimaryNodes(layout: LayoutNode): number {
    if (layout.type === "primary") return 1;
    if (layout.type === "pane") return 0;
    return countPrimaryNodes(layout.first) + countPrimaryNodes(layout.second);
}

function collectPaneIds(layout: LayoutNode, paneIds: string[] = []): string[] {
    if (layout.type === "pane") paneIds.push(layout.paneId);
    else if (layout.type === "split") {
        collectPaneIds(layout.first, paneIds);
        collectPaneIds(layout.second, paneIds);
    }
    return paneIds;
}

function parsePane(id: string, value: unknown, tabIds: Set<string>): SplitPaneRecord | undefined {
    if (!isIdentifier(id) || !isRecord(value) || value.id !== id || !isIdentifier(value.channelId) || !isIdentifier(value.activeTabId) || !Array.isArray(value.tabs) || value.tabs.length > MAXIMUM_TABS_PER_PANE) {
        return undefined;
    }

    const paneTabIds = new Set<string>();
    const channelIds = new Set<string>();
    const tabs = value.tabs.flatMap(tab => {
        if (!isRecord(tab) || !isIdentifier(tab.id) || !isIdentifier(tab.channelId) || paneTabIds.has(tab.id) || tabIds.has(tab.id) || channelIds.has(tab.channelId)) return [];
        paneTabIds.add(tab.id);
        tabIds.add(tab.id);
        channelIds.add(tab.channelId);
        return [{ id: tab.id, channelId: tab.channelId }];
    });

    const activeTab = tabs.find(tab => tab.id === value.activeTabId);
    if (!activeTab || activeTab.channelId !== value.channelId || tabs.length !== value.tabs.length) return undefined;

    return {
        id: value.id,
        channelId: value.channelId,
        tabs,
        activeTabId: value.activeTabId
    };
}

export function migratePersistedState(value: unknown): PersistedSplitState | null {
    if (!isRecord(value)) return null;

    if (value.version !== 1 && value.version !== 2 && value.version !== 3) {
        logger.warn("Ignoring a saved layout with an unsupported version", value.version);
        return null;
    }

    if (!isRecord(value.panes) || !isRecord(value.drafts)) {
        logger.warn("Ignoring a malformed saved layout");
        return null;
    }

    let layout: LayoutNode | undefined;
    const parseContext: LayoutParseContext = { nodeCount: 0, seen: new Set() };
    if (value.version === 1) {
        if (!isRatio(value.primaryRatio)) {
            logger.warn("Ignoring a malformed saved layout");
            return null;
        }

        if (value.layout === null) {
            layout = { type: "primary" };
        } else {
            const secondaryLayout = parseLayoutNode(value.layout, false, parseContext);
            if (secondaryLayout) {
                layout = {
                    type: "split",
                    direction: "vertical",
                    ratio: value.primaryRatio,
                    first: { type: "primary" },
                    second: secondaryLayout
                };
            }
        }
    } else {
        layout = parseLayoutNode(value.layout, true, parseContext);
    }

    if (!layout || countPrimaryNodes(layout) !== 1) {
        logger.warn("Ignoring a malformed saved layout");
        return null;
    }

    const paneEntries = Object.entries(value.panes);
    if (paneEntries.length > MAXIMUM_PANE_COUNT) {
        logger.warn("Ignoring a saved layout with too many panes");
        return null;
    }

    const tabIds = new Set<string>();
    const parsedPaneEntries = paneEntries.map(([id, pane]) => [id, parsePane(id, pane, tabIds)] as const);
    if (parsedPaneEntries.some(([, pane]) => pane == null)) {
        logger.warn("Ignoring a saved layout with malformed panes");
        return null;
    }
    const panes = Object.fromEntries(parsedPaneEntries) as Record<string, SplitPaneRecord>;

    const primary: PrimaryPaneRecord = { tabs: [], activeTabId: null, previewTabId: null };
    if (value.version === 3) {
        const saved = value.primary;
        if (!isRecord(saved) || !Array.isArray(saved.tabs) || saved.tabs.length > MAXIMUM_TABS_PER_PANE + 1) return null;
        const channelIds = new Set<string>();
        for (const tab of saved.tabs) {
            if (!isRecord(tab) || !isIdentifier(tab.id) || !isIdentifier(tab.channelId) || tabIds.has(tab.id) || channelIds.has(tab.channelId)) return null;
            tabIds.add(tab.id);
            channelIds.add(tab.channelId);
            primary.tabs.push({ id: tab.id, channelId: tab.channelId });
        }
        if (saved.activeTabId !== null && !primary.tabs.some(tab => tab.id === saved.activeTabId)) return null;
        if (saved.previewTabId !== null && !primary.tabs.some(tab => tab.id === saved.previewTabId)) return null;
        if (saved.tabs.length > MAXIMUM_TABS_PER_PANE && saved.previewTabId === null) return null;
        primary.activeTabId = saved.activeTabId as string | null;
        primary.previewTabId = saved.previewTabId as string | null;
    }

    const layoutPaneIds = collectPaneIds(layout);
    const uniqueLayoutPaneIds = new Set(layoutPaneIds);
    if (uniqueLayoutPaneIds.size !== layoutPaneIds.length || layoutPaneIds.some(paneId => !panes[paneId])) {
        logger.warn("Ignoring a saved layout with missing panes");
        return null;
    }

    for (const paneId of Object.keys(panes)) {
        if (!uniqueLayoutPaneIds.has(paneId)) delete panes[paneId];
    }

    const draftEntries = Object.entries(value.drafts);
    if (draftEntries.length > MAXIMUM_DRAFT_COUNT || draftEntries.some(([channelId, draft]) => !isIdentifier(channelId) || typeof draft !== "string" || draft.length > MAXIMUM_DRAFT_LENGTH)) {
        logger.warn("Ignoring a saved layout with malformed drafts");
        return null;
    }
    const drafts = Object.fromEntries(draftEntries) as Record<string, string>;

    const activePaneId = typeof value.activePaneId === "string" && panes[value.activePaneId]
        ? value.activePaneId
        : null;

    return {
        version: 3,
        layout,
        panes,
        primary,
        activePaneId,
        drafts
    };
}
