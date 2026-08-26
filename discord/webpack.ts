/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { CloudUpload } from "@vencord/discord-types";
import { findByCodeLazy, findComponentByCodeLazy } from "@webpack";
import type { ComponentType, MouseEventHandler, ReactNode } from "react";

import type { SplitChannelMessageProps } from "../compatibility/types";

// This is the same current locator used by the official MessageLinkEmbeds plugin.
// Keeping it in one module makes Discord churn fail inside a pane ErrorBoundary.
export const ChannelMessage = findComponentByCodeLazy(
    "childrenExecutedCommand:",
    ".hideAccessories"
) as ComponentType<SplitChannelMessageProps>;

export interface NativeUploadProps {
    channelId: string;
    draftType: number;
    upload: CloudUpload;
    canEdit?: boolean;
    hideFileName?: boolean;
    keyboardModeEnabled?: boolean;
    label?: ReactNode;
}

export interface NativeGif {
    id?: string;
    title?: string;
    url: string;
}

export interface NativeGifPickerProps {
    initialQuery?: string;
    onSelectGIF(gif: NativeGif): void;
    persistSearch?: boolean;
    selectedGIF?: NativeGif;
}

export interface NativeGifIconProps {
    color: string;
    size: "refresh_sm";
}

export interface NativeGifIconHook {
    Component: ComponentType<NativeGifIconProps>;
    events: {
        onMouseEnter: MouseEventHandler<HTMLElement>;
        onMouseLeave: MouseEventHandler<HTMLElement>;
    };
    play(): void;
}

// Discord's native upload card supplies the real image/file preview, remove
// action, spoiler toggle, and alt text editing. SplitView owns only the list
// container so Discord's chat-input-only attachment-area wrapper cannot
// collapse or filter out an otherwise valid pane upload.
export const NativeUpload = findComponentByCodeLazy<NativeUploadProps>(
    "hideFileName:",
    "handleEditModal:",
    "keyboardModeEnabled:"
);

// The native GIF view owns Discord's search, categories, trending results, and
// the real GIF favorites store, so saved GIFs stay identical to the main chat.
export const NativeGifPicker = findComponentByCodeLazy<NativeGifPickerProps>(
    "persistSearch||",
    "selectedGIF:",
    "initialQuery??"
);

// Native GIF composer icon hook. The dynamic chunk id distinguishes it from
// Discord's other identically-shaped animated icon hooks in the current build.
export const useNativeGifIcon = findByCodeLazy(
    'stopIfPlaying("hover")',
    'n.e("178205")'
) as () => NativeGifIconHook;
