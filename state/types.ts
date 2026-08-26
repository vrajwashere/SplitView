/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type SplitDirection = "horizontal" | "vertical";
export type SplitPlacement = "bottom" | "left" | "right" | "top";

export interface PaneTab {
    id: string;
    channelId: string;
}

export interface SplitPaneRecord {
    id: string;
    channelId: string;
    tabs: PaneTab[];
    activeTabId: string;
}

export interface PrimaryPaneRecord {
    tabs: PaneTab[];
    activeTabId: string | null;
    /** Normal navigation replaces only this unsaved tab. */
    previewTabId: string | null;
}

export type LayoutNode = {
    type: "primary";
} | {
    type: "pane";
    paneId: string;
} | {
    type: "split";
    direction: SplitDirection;
    ratio: number;
    first: LayoutNode;
    second: LayoutNode;
};

export interface PersistedSplitState {
    version: 3;
    layout: LayoutNode;
    panes: Record<string, SplitPaneRecord>;
    primary: PrimaryPaneRecord;
    activePaneId: string | null;
    drafts: Record<string, string>;
}

export interface SplitViewState extends Omit<PersistedSplitState, "drafts"> {
    hydrated: boolean;
}
