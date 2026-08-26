/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run from the Vencord checkout: node --test src/userplugins/splitView/tests/composerFocus.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { transformSync } from "esbuild";

function createHarness() {
    let effects = [];
    let activePaneId = null;
    let focused = null;
    const listeners = new Map();
    const React = {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useCallback: callback => callback,
        useEffect: effect => effects.push(effect),
        useLayoutEffect: () => {},
        useRef: current => ({ current }),
        useState: initial => [typeof initial === "function" ? initial() : initial, () => {}]
    };
    const layout = {
        getLayoutState: () => ({ activePaneId }),
        setActivePane: paneId => { activePaneId = paneId; },
        getDraft: () => "saved draft",
        commitStagedDraft: () => {},
        stageDraft: () => {}
    };
    const common = {
        ...React,
        React,
        ComponentDispatch: { dispatchToLastSubscribed: () => { focused = "primary"; } },
        DraftType: { ChannelMessage: 0 },
        Popout: { Animation: { NONE: 0 } },
        UploadAttachmentStore: { getUploads: () => [] },
        UserStore: { getCurrentUser: () => ({ id: "user" }) },
        useStateFromStores: (_stores, selector) => selector()
    };
    let paneContext;
    const mocks = {
        "@webpack/common": common,
        "@components/Icons": {},
        "../state/layoutStore": layout,
        "../context/SplitPaneContext": {
            useSplitPane: () => paneContext,
            useSplitComposerState: () => ({ composerTarget: null, setComposerTarget: () => {} })
        },
        "../discord/channel": {
            getChannel: id => ({ id }),
            getChannelHeaderDetails: () => ({ title: "Test channel" })
        },
        "../discord/permissions": { getSendAvailability: () => ({ canSend: true, canAttachFiles: true }) },
        "../discord/send": {},
        "../discord/webpack": { useNativeGifIcon: () => ({ events: {} }) },
        "../logger": {}
    };

    function load(relativePath) {
        const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
        const { code } = transformSync(source, { loader: "tsx", format: "cjs", jsx: "transform" });
        const module = { exports: {} };
        runInNewContext(code, {
            module,
            exports: module.exports,
            require: id => {
                assert.ok(id in mocks, `Unexpected import: ${id}`);
                return mocks[id];
            },
            setTimeout,
            clearTimeout,
            window: {
                addEventListener: (name, callback) => listeners.set(name, callback),
                removeEventListener: name => listeners.delete(name)
            }
        });
        return module.exports;
    }

    const manager = load("../keyboard/ComposerFocusManager.tsx");
    mocks["../keyboard/ComposerFocusManager"] = manager;
    const { SplitComposer } = load("../components/SplitComposer.tsx");

    function flushEffects() {
        const pending = effects;
        effects = [];
        const cleanups = pending.map(effect => effect()).filter(cleanup => typeof cleanup === "function");
        return () => cleanups.forEach(cleanup => cleanup());
    }

    manager.ComposerShortcuts({
        geometry: {
            primary: { x: 0, y: 0, width: 1, height: 1 },
            panes: ["pane-a", "pane-b"].map((paneId, index) => ({
                paneId,
                rect: { x: index + 1, y: 0, width: 1, height: 1 }
            }))
        }
    });
    flushEffects();

    function findTextarea(node) {
        if (!node || typeof node !== "object") return undefined;
        if (node.type === "textarea") return node;
        return node.children?.flat(Infinity).map(findTextarea).find(Boolean);
    }

    function mount(paneId, channelId) {
        paneContext = { paneId, channelId };
        const { props } = findTextarea(SplitComposer());
        const textarea = {
            isConnected: true,
            disabled: false,
            value: props.value,
            focus: () => { focused = textarea; props.onFocus(); },
            setSelectionRange: (start, end) => { textarea.selection = [start, end]; }
        };
        props.ref(textarea);
        return {
            textarea,
            cleanup: flushEffects(),
            detach: () => { props.ref(null); textarea.isConnected = false; }
        };
    }

    function shortcut(key, code, altKey = false) {
        let prevented = false;
        listeners.get("keydown")({
            key, code, ctrlKey: true, shiftKey: !altKey, altKey,
            preventDefault: () => { prevented = true; },
            stopPropagation: () => {}
        });
        assert.ok(prevented, "Shortcut should be handled");
    }

    return {
        mount,
        shortcut,
        get activePaneId() { return activePaneId; },
        get focused() { return focused; }
    };
}

test("pane shortcuts focus the current textbox after repeated tab replacements", () => {
    const harness = createHarness();
    let current = harness.mount("pane-a", "channel-1");
    const other = harness.mount("pane-b", "other-channel");
    try {
        harness.shortcut(" ", "Space");
        assert.equal(harness.focused, current.textarea);

        for (const channelId of ["channel-2", "channel-3", "channel-1"]) {
            const previous = current;
            previous.detach();
            current = harness.mount("pane-a", channelId);
            // React attaches the new ref in the commit before the old tab's
            // passive unmount effects run. Those must not unregister the new ref.
            previous.cleanup();

            harness.shortcut("3", "Digit3", true);
            assert.equal(harness.focused, other.textarea);
            harness.shortcut("ArrowLeft", "ArrowLeft");
            assert.equal(harness.activePaneId, "pane-a");
            assert.equal(harness.focused, current.textarea);
            assert.deepEqual(current.textarea.selection, [11, 11]);

            harness.shortcut("1", "Digit1", true);
            assert.equal(harness.focused, "primary");
            harness.shortcut(" ", "Space");
            assert.equal(harness.focused, current.textarea);
            harness.shortcut("2", "Digit2", true);
            assert.equal(harness.focused, current.textarea);
        }
    } finally {
        current.detach();
        current.cleanup();
        other.detach();
        other.cleanup();
    }
});

test("disabled and unregistered textboxes are not focused", () => {
    const harness = createHarness();
    const current = harness.mount("pane-a", "channel-1");
    try {
        current.textarea.disabled = true;
        harness.shortcut("2", "Digit2", true);
        assert.equal(harness.focused, null);
        current.textarea.disabled = false;
        current.detach();
        // Keep it connected to verify removal from the registry, not just the
        // disconnected-element guard in focusSplitComposer.
        current.textarea.isConnected = true;
        harness.shortcut("2", "Digit2", true);
        assert.equal(harness.focused, null);
    } finally {
        current.cleanup();
    }
});
