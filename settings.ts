/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { forgetPersistedState } from "./state/persistence";

export const settings = definePluginSettings({
    minimumPaneWidth: {
        type: OptionType.SLIDER,
        description: "Preferred minimum width, in pixels, for each view while resizing",
        markers: [260, 300, 320, 360, 400, 480],
        default: 320,
        stickToMarkers: false
    },
    rememberLayout: {
        type: OptionType.BOOLEAN,
        description: "Persist the pane tree, split ratios, tabs, and per-channel drafts",
        default: true,
        onChange: rememberLayout => {
            if (!rememberLayout) void forgetPersistedState();
        }
    },
    restorePanesAfterRestart: {
        type: OptionType.BOOLEAN,
        description: "Restore saved split panes when Discord restarts",
        default: true
    },
    maximumRenderedMessages: {
        type: OptionType.SLIDER,
        description: "Maximum number of real Discord message components rendered in the secondary pane",
        markers: [100, 150, 200, 250, 300],
        default: 200
    },
    enableDragToSplit: {
        type: OptionType.BOOLEAN,
        description: "Drag DMs, guild channels, and threads from Discord's sidebar into the split workspace",
        default: true
    },
    showPaneTabs: {
        type: OptionType.BOOLEAN,
        description: "Show browser-style tabs for channels opened in the secondary pane",
        default: true
    },
    maximumPaneCount: {
        type: OptionType.SLIDER,
        description: "Maximum total views, including Discord's primary chat",
        markers: [2, 3, 4],
        default: 4,
        stickToMarkers: true
    }
});
