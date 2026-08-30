/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PlusIcon } from "@components/Icons";
import type { CloudUpload, Emoji } from "@vencord/discord-types";
import { EmojiIntention } from "@vencord/discord-types/enums";
import { ChannelStore, DraftType, EmojiStore, GuildStore, MessageStore, PermissionsBits, PermissionStore, Popout, React, UploadAttachmentStore, UploadHandler, UploadManager, useEffect, useLayoutEffect, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";
import type { ChangeEvent, ClipboardEvent, ComponentType, DragEvent, KeyboardEvent } from "react";

import { useSplitComposerState, useSplitPane } from "../context/SplitPaneContext";
import { getChannel, getChannelHeaderDetails } from "../discord/channel";
import { getComposerWord, replaceComposerRange } from "../discord/composerText";
import { getSendAvailability } from "../discord/permissions";
import { editPaneMessage, sendPaneMessage, sendPaneReply } from "../discord/send";
import { NativeAutocomplete, type NativeAutocompleteEditor, type NativeAutocompleteHandle, NativeEmojiButton, NativeEmojiPicker, type NativeEmojiPickerSelection, type NativeGif, NativeGifPicker, NativeUpload, useNativeGifIcon } from "../discord/webpack";
import { registerSplitComposer, unregisterSplitComposer } from "../keyboard/ComposerFocusManager";
import { logger } from "../logger";
import { clearDraftAtRevision, commitStagedDraft, getDraft, getDraftRevision, getLayoutState, MAXIMUM_DRAFT_LENGTH, setActivePane, stageDraft } from "../state/layoutStore";

const DRAFT_SYNC_DELAY_MS = 250;
const SPLIT_CHAT_INPUT_TYPE = {
    autocomplete: {
        addReactionShortcut: false,
        alwaysUseLayer: false,
        forceChatLayer: false,
        small: false
    },
    commands: { enabled: false },
    expressionPicker: { emojiIntention: EmojiIntention.CHAT },
    users: { allowMentioning: true }
};

function restoreTextareaFocus(textarea: HTMLTextAreaElement | null, paneId: string, channelId: string): void {
    // Discord may focus its native composer after SEND_MESSAGE finishes. Waiting
    // for two paint frames lets that work settle before restoring this pane's
    // independent caret.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!textarea?.isConnected || textarea.disabled) return;
        const layout = getLayoutState();
        if (layout.activePaneId !== paneId || layout.panes[paneId]?.channelId !== channelId) return;
        textarea.focus({ preventScroll: true });
        const caret = textarea.value.length;
        textarea.setSelectionRange(caret, caret);
    }));
}

function uploadsAreIdentical(first: readonly CloudUpload[], second: readonly CloudUpload[]): boolean {
    return first.length === second.length && first.every((upload, index) => upload === second[index]);
}

export function SplitComposer() {
    const { active = true, paneId, channelId } = useSplitPane();
    const { composerTarget, setComposerTarget } = useSplitComposerState();
    const [draft, setLocalDraft] = useState(() => getDraft(channelId));
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const gifButtonRef = useRef<HTMLButtonElement>(null);
    const emojiButtonRef = useRef<HTMLElement>(null);
    const autocompleteRef = useRef<NativeAutocompleteHandle>(null);
    const autocompleteEditorRef = useRef<NativeAutocompleteEditor>(null);
    const composerSelectionRef = useRef({ start: draft.length, end: draft.length });
    const draftRef = useRef(draft);
    const composerValueRef = useRef(draft);
    const sendingRef = useRef(false);
    const [editContent, setEditContent] = useState("");
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string>();
    const [composerFocused, setComposerFocused] = useState(false);
    const [autocompleteVisible, setAutocompleteVisible] = useState(false);
    const [fileInputVersion, setFileInputVersion] = useState(0);
    const channel = getChannel(channelId);
    const availability = useStateFromStores(
        [ChannelStore, PermissionStore],
        () => getSendAvailability(getChannel(channelId)),
        [channelId],
        (previous, next) => previous.canAttachFiles === next.canAttachFiles
            && previous.canSend === next.canSend
            && previous.reason === next.reason
    );
    const canMentionEveryone = useStateFromStores(
        [ChannelStore, PermissionStore],
        () => {
            const currentChannel = getChannel(channelId);
            return Boolean(currentChannel && (
                currentChannel.isPrivate()
                || PermissionStore.can(PermissionsBits.MENTION_EVERYONE, currentChannel)
            ));
        },
        [channelId]
    );
    const uploads = useStateFromStores(
        [UploadAttachmentStore],
        () => [...UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage)],
        [channelId],
        uploadsAreIdentical
    );
    const targetMessage = useStateFromStores(
        [MessageStore],
        () => composerTarget ? MessageStore.getMessage(channelId, composerTarget.messageId) : undefined,
        [channelId, composerTarget?.messageId]
    );
    const currentUserId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
    const { Component: GifIcon, events: gifIconEvents, play: playGifIcon } = useNativeGifIcon();

    const editing = composerTarget?.kind === "edit";
    const value = editing ? editContent : draft;
    const hasContent = value.trim().length > 0;
    const hasUploads = !editing && uploads.length > 0;
    const hasPayload = hasContent || hasUploads;
    const unchangedEdit = editing && targetMessage?.content === editContent;
    const canSubmit = availability.canSend && hasPayload && !unchangedEdit && !sending;
    const channelTitle = useStateFromStores(
        [ChannelStore, GuildStore, UserStore],
        () => {
            const currentChannel = getChannel(channelId);
            return currentChannel ? getChannelHeaderDetails(currentChannel).title : "this channel";
        },
        [channelId]
    );
    const setTextareaRef = React.useCallback((textarea: HTMLTextAreaElement | null) => {
        const previous = textareaRef.current;
        textareaRef.current = textarea;
        if (textarea) {
            if (active) registerSplitComposer(paneId, textarea);
        } else if (previous) {
            unregisterSplitComposer(paneId, previous);
        }
    }, [active, paneId]);

    draftRef.current = draft;
    composerValueRef.current = value;
    autocompleteEditorRef.current = {
        getCurrentWord() {
            const selection = readComposerSelection();
            const word = getComposerWord(composerValueRef.current, selection.start, selection.end);
            return { word: word.word, isAtStart: word.isAtStart };
        },
        getSlateEditor() {
            return null;
        },
        insertAutocomplete(displayText, rawText) {
            insertAutocompleteText(displayText, rawText);
        }
    };

    useEffect(() => {
        const timer = setTimeout(() => commitStagedDraft(channelId), DRAFT_SYNC_DELAY_MS);
        return () => clearTimeout(timer);
    }, [channelId, draft]);

    useEffect(() => () => {
        stageDraft(channelId, draftRef.current);
        commitStagedDraft(channelId);
    }, [channelId]);

    useLayoutEffect(() => {
        if (composerTarget?.kind === "edit") setEditContent(composerTarget.initialContent);
        setSendError(undefined);
    }, [composerTarget]);

    useEffect(() => {
        if (composerTarget && !targetMessage) setComposerTarget(null);
    }, [composerTarget, setComposerTarget, targetMessage]);

    useLayoutEffect(() => {
        if (!composerTarget) return;
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus({ preventScroll: true });
        const caret = textarea.value.length;
        composerSelectionRef.current = { start: caret, end: caret };
        textarea.setSelectionRange(caret, caret);
    }, [composerTarget]);

    function readComposerSelection(): { start: number; end: number; } {
        const textarea = textareaRef.current;
        if (!textarea) return composerSelectionRef.current;
        return {
            start: textarea.selectionStart ?? composerSelectionRef.current.start,
            end: textarea.selectionEnd ?? composerSelectionRef.current.end
        };
    }

    function rememberComposerSelection(textarea: HTMLTextAreaElement): void {
        composerSelectionRef.current = {
            start: textarea.selectionStart ?? 0,
            end: textarea.selectionEnd ?? textarea.selectionStart ?? 0
        };
    }

    function updateComposerValue(nextValue: string): void {
        composerValueRef.current = nextValue;
        if (editing) setEditContent(nextValue);
        else updateDraft(nextValue);
    }

    function applyComposerInsertion(start: number, end: number, text: string, addTrailingSpace: boolean): void {
        const replacement = replaceComposerRange(composerValueRef.current, start, end, text, addTrailingSpace);
        if (replacement.value.length > MAXIMUM_DRAFT_LENGTH) {
            setSendError(`Messages can contain at most ${MAXIMUM_DRAFT_LENGTH.toLocaleString()} characters.`);
            return;
        }

        setSendError(undefined);
        composerSelectionRef.current = { start: replacement.caret, end: replacement.caret };
        updateComposerValue(replacement.value);
        requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            if (!textarea?.isConnected || textarea.disabled) return;
            textarea.focus({ preventScroll: true });
            textarea.setSelectionRange(replacement.caret, replacement.caret);
        });
    }

    function formatEmoji(emoji: Emoji): string {
        const name = (emoji.originalName ?? emoji.name).replaceAll(":", "");
        if (emoji.id) return `<${emoji.animated ? "a" : ""}:${name}:${emoji.id}>`;
        if ("optionallyDiverseSequence" in emoji) {
            return emoji.optionallyDiverseSequence ?? emoji.surrogates;
        }
        return `:${name}:`;
    }

    function resolveAutocompleteText(displayText: string, rawText?: string): string {
        const text = rawText ?? displayText;
        const emojiAlias = /^:([^:]+):$/.exec(text);
        if (!emojiAlias) return text;

        const emoji = EmojiStore
            .getDisambiguatedEmojiContext(channel?.guild_id)
            .getByName(emojiAlias[1]);
        return emoji ? formatEmoji(emoji) : text;
    }

    function insertAutocompleteText(displayText: string, rawText?: string): void {
        const selection = readComposerSelection();
        const word = getComposerWord(composerValueRef.current, selection.start, selection.end);
        applyComposerInsertion(word.start, word.end, resolveAutocompleteText(displayText, rawText), true);
    }

    function insertSelectedEmoji(selection: NativeEmojiPickerSelection, closePopout: () => void): void {
        if (!selection.emoji) return;
        const currentSelection = readComposerSelection();
        applyComposerInsertion(
            currentSelection.start,
            currentSelection.end,
            formatEmoji(selection.emoji),
            selection.willClose
        );
        if (selection.willClose) closePopout();
    }

    async function submit(contentOverride?: string) {
        const content = contentOverride ?? value;
        const submittedUploads = editing
            ? []
            : [...UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage)];
        if ((!content.trim() && submittedUploads.length === 0) || !availability.canSend || sendingRef.current) return;

        const textarea = textareaRef.current;
        const submittedDraftRevision = getDraftRevision(channelId);
        const submittedTarget = composerTarget;
        sendingRef.current = true;
        setSending(true);
        setSendError(undefined);
        try {
            if (submittedTarget?.kind === "edit") {
                await editPaneMessage(channelId, submittedTarget.messageId, content);
                setComposerTarget(current => current === submittedTarget ? null : current);
            } else if (submittedTarget?.kind === "reply" && channel && targetMessage) {
                await sendPaneReply(
                    channel,
                    targetMessage,
                    content,
                    targetMessage.author.id !== currentUserId,
                    submittedUploads
                );
                clearSubmittedPayload();
                setComposerTarget(current => current === submittedTarget ? null : current);
            } else {
                await sendPaneMessage(channelId, content, submittedUploads);
                clearSubmittedPayload();
            }
        } catch (error) {
            logger.error("Failed to submit a message", { channelId, composerTarget: submittedTarget, error });
            setSendError(editing
                ? "Message failed to update. Your edit was kept."
                : "Message failed to send. Your draft was kept.");
        } finally {
            sendingRef.current = false;
            setSending(false);
            restoreTextareaFocus(textarea, paneId, channelId);
        }

        function clearSubmittedPayload(): void {
            if (submittedUploads.length > 0) {
                const currentUploads = UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage);
                if (uploadsAreIdentical(submittedUploads, currentUploads)) {
                    UploadManager.clearAll(channelId, DraftType.ChannelMessage);
                }
            }

            if (contentOverride == null && clearDraftAtRevision(channelId, submittedDraftRevision)) {
                setLocalDraft(current => current === content ? "" : current);
            }
        }
    }

    function attachFiles(files: File[]): void {
        if (!availability.canAttachFiles || editing || !channel || files.length === 0) return;
        setSendError(undefined);
        try {
            UploadHandler.promptToUpload(files, channel, DraftType.ChannelMessage);
        } catch (error) {
            logger.error("Failed to add attachments", { channelId, error });
            setSendError("Discord could not add those attachments.");
        }
    }

    function onFileInputChange(event: ChangeEvent<HTMLInputElement>): void {
        attachFiles(Array.from(event.currentTarget.files ?? []));
        // Let React reset the input so the same file can be selected again.
        setFileInputVersion(version => version + 1);
    }

    function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0 || !availability.canAttachFiles || editing) return;
        event.preventDefault();
        attachFiles(files);
    }

    function onDragOver(event: DragEvent<HTMLDivElement>): void {
        if (!availability.canAttachFiles || editing || event.dataTransfer.types.indexOf("Files") === -1) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    }

    function onDrop(event: DragEvent<HTMLDivElement>): void {
        if (!availability.canAttachFiles || editing) return;
        const files = Array.from(event.dataTransfer.files);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        attachFiles(files);
    }

    function onSelectGif(gif: NativeGif, closePopout: () => void): void {
        closePopout();
        void submit(gif.url);
    }

    function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        const autocomplete = autocompleteRef.current;
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" && autocomplete?.isVisible()) {
            event.preventDefault();
            event.stopPropagation();
            autocomplete.onHideAutocomplete();
            return;
        }
        if (!event.altKey && !event.ctrlKey && !event.metaKey) {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                if (autocomplete?.onMoveSelection(event.key === "ArrowUp" ? -1 : 1)) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
            }
            if (event.key === "Tab" && !event.shiftKey && autocomplete?.onTabOrEnter(false)) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (event.key === "Enter" && !event.shiftKey && autocomplete?.onTabOrEnter(true)) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (event.key === " " && autocomplete?.onSpace()) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
        }
        if (event.key === "Escape" && composerTarget) {
            event.preventDefault();
            event.stopPropagation();
            setComposerTarget(null);
            return;
        }
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        void submit();
    }

    function updateDraft(nextDraft: string): void {
        draftRef.current = nextDraft;
        stageDraft(channelId, nextDraft);
        setLocalDraft(nextDraft);
    }

    return (
        <div className="vc-splitview-composer-wrap">
            {channel && (
                <NativeAutocomplete
                    ref={autocompleteRef}
                    channel={channel}
                    type={SPLIT_CHAT_INPUT_TYPE}
                    editorHeight={textareaRef.current?.clientHeight ?? 40}
                    editorRef={autocompleteEditorRef}
                    targetRef={textareaRef}
                    textValue={value}
                    focused={composerFocused && !sending && availability.canSend}
                    expressionPickerView={null}
                    position="top"
                    barsHeight={0}
                    canMentionUsers
                    canMentionRoles={Boolean(channel.guild_id)}
                    canMentionChannels={Boolean(channel.guild_id)}
                    canMentionEveryone={canMentionEveryone}
                    canOnlyUseTextCommands
                    canSendStickers={false}
                    canSendSoundmoji={false}
                    useNewSlashCommands={false}
                    setValue={updateComposerValue}
                    onVisibilityChange={setAutocompleteVisible}
                />
            )}
            {composerTarget && targetMessage && (
                <div className="vc-splitview-composer-target">
                    <div>
                        <strong>{editing ? "Editing message" : `Replying to ${targetMessage.author.globalName ?? targetMessage.author.username}`}</strong>
                        <span>{targetMessage.content || "Message attachment"}</span>
                    </div>
                    <button
                        type="button"
                        aria-label={editing ? "Cancel edit" : "Cancel reply"}
                        title={editing ? "Cancel edit" : "Cancel reply"}
                        onClick={() => setComposerTarget(null)}
                    >
                        ×
                    </button>
                </div>
            )}
            {hasUploads && (
                <div className="vc-splitview-attachments">
                    <ul className="vc-splitview-attachment-list" aria-label="Attachments">
                        {uploads.map(upload => (
                            <NativeUpload
                                key={upload.id}
                                channelId={channelId}
                                draftType={DraftType.ChannelMessage}
                                upload={upload}
                            />
                        ))}
                    </ul>
                </div>
            )}
            <div
                className={`vc-splitview-composer${hasUploads ? " vc-splitview-composer-with-attachments" : ""}`}
                onDragOver={onDragOver}
                onDrop={onDrop}
            >
                {!editing && (
                    <>
                        <input
                            key={fileInputVersion}
                            ref={fileInputRef}
                            className="vc-splitview-file-input"
                            type="file"
                            multiple
                            tabIndex={-1}
                            aria-hidden="true"
                            onChange={onFileInputChange}
                        />
                        <button
                            type="button"
                            className="vc-splitview-composer-action"
                            disabled={!availability.canAttachFiles || sending}
                            aria-label="Upload a file"
                            title={availability.canAttachFiles ? "Upload a file" : "You cannot attach files in this channel"}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <PlusIcon width={24} height={24} aria-hidden="true" />
                        </button>
                    </>
                )}
                <textarea
                    ref={setTextareaRef}
                    value={value}
                    rows={1}
                    maxLength={MAXIMUM_DRAFT_LENGTH}
                    aria-label={`Message ${channelTitle}`}
                    aria-busy={sending}
                    aria-autocomplete="list"
                    aria-expanded={autocompleteVisible}
                    aria-keyshortcuts="Control+ArrowLeft Control+ArrowRight Control+Shift+Space Control+Shift+ArrowLeft Control+Shift+ArrowRight Control+Shift+ArrowUp Control+Shift+ArrowDown"
                    placeholder={availability.canSend ? (editing ? "Edit message" : `Message ${channelTitle}`) : availability.reason}
                    data-splitview-composer="true"
                    disabled={!availability.canSend}
                    readOnly={sending}
                    onChange={event => {
                        rememberComposerSelection(event.currentTarget);
                        updateComposerValue(event.currentTarget.value);
                    }}
                    onFocus={() => {
                        setComposerFocused(true);
                        setActivePane(paneId);
                    }}
                    onBlur={() => setComposerFocused(false)}
                    onSelect={event => {
                        rememberComposerSelection(event.currentTarget);
                        autocompleteRef.current?.onMaybeShowAutocomplete();
                    }}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                />
                <Popout
                    position="top"
                    align="right"
                    animation={Popout.Animation.NONE}
                    spacing={8}
                    targetElementRef={emojiButtonRef}
                    renderPopout={({ closePopout }) => channel && (
                        <NativeEmojiPicker
                            channel={channel}
                            persistSearch
                            pickerIntention={EmojiIntention.CHAT}
                            closePopout={closePopout}
                            onNavigateAway={closePopout}
                            onSelectEmoji={selection => insertSelectedEmoji(selection, closePopout)}
                        />
                    )}
                >
                    {(popoutProps, { isShown }) => (
                        <NativeEmojiButton
                            {...popoutProps}
                            ref={emojiButtonRef}
                            active={isShown}
                            className="vc-splitview-composer-action vc-splitview-emoji-button"
                            disabled={!availability.canSend || sending}
                            aria-label="Open emoji picker"
                            tooltipText="Open emoji picker"
                            title="Open emoji picker"
                            onClick={event => {
                                autocompleteRef.current?.onHideAutocomplete();
                                popoutProps.onClick(event);
                            }}
                        />
                    )}
                </Popout>
                {!editing && (
                    <Popout
                        position="top"
                        align="right"
                        animation={Popout.Animation.NONE}
                        spacing={8}
                        targetElementRef={gifButtonRef}
                        renderPopout={({ closePopout }) => (
                            <div className="vc-splitview-gif-picker">
                                <NativeGifPicker
                                    persistSearch
                                    onSelectGIF={gif => onSelectGif(gif, closePopout)}
                                />
                            </div>
                        )}
                    >
                        {(popoutProps, { isShown }) => (
                            <button
                                ref={gifButtonRef}
                                type="button"
                                className={`vc-splitview-composer-action vc-splitview-gif-button${isShown ? " vc-splitview-composer-action-selected" : ""}`}
                                disabled={!availability.canSend || sending}
                                aria-label="Open GIF picker"
                                title="Open GIF picker"
                                {...popoutProps}
                                onClick={event => {
                                    playGifIcon();
                                    popoutProps.onClick(event);
                                }}
                                onMouseEnter={gifIconEvents.onMouseEnter}
                                onMouseLeave={gifIconEvents.onMouseLeave}
                            >
                                <GifIcon size="refresh_sm" color="currentColor" />
                            </button>
                        )}
                    </Popout>
                )}
                {hasPayload && (
                    <button
                        type="button"
                        className="vc-splitview-send-button"
                        disabled={!canSubmit}
                        aria-label={editing ? "Save edit" : "Send message"}
                        title={sending ? (editing ? "Saving edit" : "Sending message") : (editing ? "Save edit" : "Send message")}
                        onClick={() => void submit()}
                    >
                        {sending
                            ? <span className="vc-splitview-send-spinner" aria-hidden="true" />
                            : (
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path fill="currentColor" d="M3.4 2.3a1 1 0 0 0-1.3 1.2l2.2 7.1 8.2 1.4-8.2 1.4-2.2 7.1a1 1 0 0 0 1.3 1.2l18-8.8a1 1 0 0 0 0-1.8l-18-8.8Z" />
                                </svg>
                            )}
                    </button>
                )}
            </div>
            {sendError && (
                <div className="vc-splitview-composer-status" role="status">
                    {sendError}
                </div>
            )}
        </div>
    );
}

let memoizedSplitComposer: ComponentType | undefined;

/** Keep pane focus/layout updates out of the controlled composer hot path. */
export function StableSplitComposer() {
    const MemoizedSplitComposer = memoizedSplitComposer ??= React.memo(SplitComposer);
    return <MemoizedSplitComposer />;
}
