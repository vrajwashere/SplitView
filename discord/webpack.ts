/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, CloudUpload, Emoji } from "@vencord/discord-types";
import { findByCodeLazy, findComponentByCodeLazy } from "@webpack";
import type { ComponentType, MouseEventHandler, ReactNode, Ref, RefObject } from "react";

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

export interface NativeEmojiPickerSelection {
    emoji: Emoji | null;
    isBurst?: boolean;
    willClose: boolean;
}

export interface NativeEmojiPickerProps {
    channel: Channel;
    closePopout(): void;
    containerWidth?: number;
    guildId?: string;
    onNavigateAway?(): void;
    onSelectEmoji(selection: NativeEmojiPickerSelection): void;
    persistSearch?: boolean;
    pickerIntention: number;
}

export interface NativeEmojiButtonProps {
    active?: boolean;
    "aria-label"?: string;
    className?: string;
    disabled?: boolean;
    onClick?: MouseEventHandler<HTMLElement>;
    ref?: Ref<HTMLElement>;
    tabIndex?: number;
    title?: string;
    tooltipText?: string;
}

export interface NativeAutocompleteEditor {
    getCurrentWord(): { isAtStart: boolean; word: string; };
    getSlateEditor(): null;
    insertAutocomplete(displayText: string, rawText?: string): void;
}

export interface NativeAutocompleteHandle {
    isVisible(): boolean;
    onHideAutocomplete(): void;
    onMaybeShowAutocomplete(): void;
    onMoveSelection(offset: number): boolean;
    onSpace(): boolean;
    onTabOrEnter(shouldSubmit: boolean): boolean;
}

export interface NativeAutocompleteProps {
    barsHeight?: number;
    canMentionChannels?: boolean;
    canMentionEveryone?: boolean;
    canMentionRoles?: boolean;
    canMentionUsers?: boolean;
    canOnlyUseTextCommands?: boolean;
    canSendSoundmoji?: boolean;
    canSendStickers?: boolean;
    channel: Channel;
    editorHeight: number;
    editorRef: RefObject<NativeAutocompleteEditor | null>;
    expressionPickerView?: null;
    focused: boolean;
    onVisibilityChange(visible: boolean): void;
    position?: "bottom" | "top";
    ref?: Ref<NativeAutocompleteHandle>;
    setValue(value: string, richValue?: unknown): void;
    targetRef: RefObject<HTMLElement | null>;
    textValue: string;
    type: {
        autocomplete?: {
            addReactionShortcut?: boolean;
            alwaysUseLayer?: boolean;
            forceChatLayer?: boolean;
            small?: boolean;
        };
        commands?: { enabled: boolean; };
        expressionPicker?: { emojiIntention: number; };
        users?: { allowMentioning: boolean; };
    };
    useNewSlashCommands?: boolean;
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

// Discord's autocomplete controller and renderer own the actual mention,
// role, channel, and emoji queries plus their native result rows. The editor
// adapter lets a controlled SplitView textarea receive the selected raw text
// without selecting the pane as Discord's global channel.
export const NativeAutocomplete = findComponentByCodeLazy<NativeAutocompleteProps>(
    "currentWordIsAtStart:",
    "hideMentionDescription:",
    "onVisibilityChange"
);

// Native emoji picker and its animated composer button. Keeping both native
// preserves Discord's categories, favorites, frecency, Nitro gating, skin
// tones, keyboard navigation, and accessibility behavior.
export const NativeEmojiPicker = findComponentByCodeLazy<NativeEmojiPickerProps>(
    "shouldShowSoundmojiInEmojiPicker:",
    "showOnlyUnicode:",
    "analyticsOverride:"
);

export const NativeEmojiButton = findComponentByCodeLazy<NativeEmojiButtonProps>(
    "canShowNUXPremiumTooltip:",
    "spritePremiumColored",
    "keyboardShortcut:"
);

// Native GIF composer icon hook. The dynamic chunk id distinguishes it from
// Discord's other identically-shaped animated icon hooks in the current build.
export const useNativeGifIcon = findByCodeLazy(
    'stopIfPlaying("hover")',
    'n.e("178205")'
) as () => NativeGifIconHook;
