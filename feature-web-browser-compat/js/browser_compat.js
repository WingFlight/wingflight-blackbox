"use strict";

/**
 * Compatibility layer for running the Blackbox Explorer in a plain browser tab instead of
 * inside the NW.js desktop shell. NW.js exposes a subset of the Chrome Apps platform
 * (chrome.i18n, chrome.runtime, require('nw.gui'), ...) that a normal web page does not have;
 * this file fills in just enough of that surface for the app to run unmodified elsewhere.
 *
 * Every shim here only installs itself when the real NW.js/Chrome API is missing, so this
 * file is a no-op inside the desktop build.
 *
 * Must be loaded before any script that calls chrome.i18n.getMessage(), getManifestVersion(),
 * or window.isNWjs() -- see index.html.
 */
(function () {
    /**
     * True when running inside the NW.js desktop shell, false in a plain browser tab. Use this
     * instead of calling require('nw.gui') directly so desktop-only code (native windows, OS
     * file-association open, external-link handling) degrades gracefully on the web, where
     * `require` doesn't exist at all.
     */
    window.isNWjs = function () {
        if (typeof require !== 'function') {
            return false;
        }
        try {
            require('nw.gui');
            return true;
        } catch (_e) {
            return false;
        }
    };

    if (window.isNWjs()) {
        return;
    }

    window.chrome = window.chrome || {};

    // chrome.i18n.getMessage() backs every [i18n]/[i18n_title]/... attribute in index.html
    // (see js/localization.js) plus the update-notice string in index.js. NW.js serves this
    // from _locales/<lang>/messages.json; we load the same file ourselves.
    if (!window.chrome.i18n) {
        var i18nMessages = null;

        (function loadI18nMessages() {
            var locale = 'en'; // only English is shipped today; add a lookup here if that changes

            try {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', '_locales/' + locale + '/messages.json', false);
                xhr.send(null);

                if (xhr.status === 200 || xhr.status === 0) { // status 0: local file:// requests
                    i18nMessages = JSON.parse(xhr.responseText);
                }
            } catch (e) {
                console.error('browser_compat: failed to load i18n messages', e);
            }

            i18nMessages = i18nMessages || {};
        })();

        window.chrome.i18n = {
            getMessage: function (messageId, substitutions) {
                var entry = i18nMessages[messageId];

                // Real chrome.i18n.getMessage() returns "" for an unknown id; we return the id
                // itself instead so a missing/failed-to-load string is visible, not blank.
                if (!entry) {
                    return messageId;
                }

                var message = entry.message;

                if (substitutions !== undefined) {
                    var subs = Array.isArray(substitutions) ? substitutions : [substitutions];
                    subs.forEach(function (value, index) {
                        message = message.split('$' + (index + 1)).join(value);
                    });
                }

                return message;
            }
        };
    }

    // chrome.runtime.getManifest() is only used by getManifestVersion() (js/tools.js) to read
    // the app's version. Under NW.js, package.json *is* the manifest; we fetch the same file so
    // the version reported in the UI matches.
    if (!window.chrome.runtime) {
        window.chrome.runtime = {};
    }

    if (!window.chrome.runtime.getManifest) {
        var cachedManifest = null;

        window.chrome.runtime.getManifest = function () {
            if (!cachedManifest) {
                try {
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', 'package.json', false);
                    xhr.send(null);

                    if (xhr.status === 200 || xhr.status === 0) {
                        cachedManifest = JSON.parse(xhr.responseText);
                    }
                } catch (e) {
                    console.error('browser_compat: failed to load package.json manifest', e);
                }
            }

            if (!cachedManifest) {
                // Matches the failure mode getManifestVersion() already expects and handles.
                throw new Error('manifest unavailable');
            }

            return cachedManifest;
        };
    }

    // chrome.storage.local already has a localStorage fallback in js/pref_storage.js, and
    // chrome.app.window is only reached from code paths that are now gated behind
    // window.isNWjs(), so neither needs a shim here.
})();
