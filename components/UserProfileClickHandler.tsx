/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, Message } from "@vencord/discord-types";
import { UserProfileActions } from "@webpack/common";
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode, RefObject, SyntheticEvent } from "react";

const PROFILE_TRIGGER_SELECTOR = [
    '[class*="avatar" i]',
    '[class*="username" i]'
].join(",");

const NESTED_AVATAR_SELECTOR = [
    '[id^="message-reply-context-"]',
    '[class*="repliedMessage" i]',
    '[class*="embed" i]',
    '[class*="attachment" i]',
    '[class*="reaction" i]'
].join(",");

interface UserProfileClickHandlerProps {
    channel: Channel;
    children: ReactNode;
    messageListRef: RefObject<HTMLDivElement | null>;
    messages: readonly Message[];
    style?: CSSProperties;
}

function getProfileTrigger(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;

    const row = target.closest<HTMLElement>(".vc-splitview-message-row");
    if (!row) return null;

    const classTrigger = target.closest<HTMLElement>(PROFILE_TRIGGER_SELECTOR);
    if (classTrigger?.closest(".vc-splitview-message-row") === row) {
        const isAvatar = classTrigger.matches('[class*="avatar" i]')
            && !classTrigger.closest(NESTED_AVATAR_SELECTOR);
        const isUsername = classTrigger.matches('[class*="username" i]')
            && Boolean(classTrigger.closest('h3, [class*="header_"]'));
        if (isAvatar || isUsername) return classTrigger;
    }

    // Some Discord avatar variants put the hashed avatar class on a sibling
    // wrapper rather than the image receiving the pointer event.
    const image = target.closest<HTMLImageElement>("img");
    const imageUrl = image?.currentSrc || image?.src || "";
    if (
        image?.closest(".vc-splitview-message-row") === row
        && !image.closest(NESTED_AVATAR_SELECTOR)
        && /\/(?:avatars|embed\/avatars)\//.test(imageUrl)
    ) {
        return image;
    }

    // Discord occasionally changes the hashed username class. The author is
    // consistently the first interactive element in the message heading;
    // later buttons are server tags, role icons, or new-member badges.
    const interactive = target.closest<HTMLElement>('button, [role="button"]');
    const heading = interactive?.closest<HTMLElement>('h3, [class*="header_"]');
    if (!interactive || !heading || heading.closest(".vc-splitview-message-row") !== row) return null;

    return heading.querySelector<HTMLElement>('button, [role="button"]') === interactive
        ? interactive
        : null;
}

function getMessageForTrigger(trigger: HTMLElement, messages: readonly Message[]): Message | undefined {
    const messageId = trigger.closest<HTMLElement>(".vc-splitview-message-row")?.dataset.messageId;
    return messageId ? messages.find(message => message.id === messageId) : undefined;
}

export function UserProfileClickHandler({ channel, children, messageListRef, messages, style }: UserProfileClickHandlerProps) {
    function openProfile(event: SyntheticEvent<HTMLDivElement>, target: EventTarget | null): void {
        const trigger = getProfileTrigger(target);
        if (!trigger) return;

        const message = getMessageForTrigger(trigger, messages);
        if (!message?.author?.id) return;

        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();

        UserProfileActions.openUserProfileModal({
            userId: message.author.id,
            guildId: channel.guild_id || undefined,
            channelId: channel.id,
            messageId: message.id,
            analyticsLocation: {
                page: channel.guild_id ? "Guild Channel" : "DM Channel",
                section: "Profile Popout"
            }
        });
    }

    return (
        <div
            ref={messageListRef}
            className="vc-splitview-message-list"
            style={style}
            onKeyDownCapture={(event: KeyboardEvent<HTMLDivElement>) => {
                if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
                openProfile(event, event.target);
            }}
            // Pointer-up is intentional: activating an inactive pane during
            // pointer-down can make the browser suppress the subsequent click.
            onPointerUpCapture={(event: PointerEvent<HTMLDivElement>) => {
                if (event.button === 0) openProfile(event, event.target);
            }}
        >
            {children}
        </div>
    );
}
