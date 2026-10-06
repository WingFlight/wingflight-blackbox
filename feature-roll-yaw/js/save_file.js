"use strict";

/**
 * Ask the user where to save a file, returning a Promise that resolves to a save target, or to null if the user
 * cancelled.
 *
 * Browsers only allow the save picker to be opened shortly after a user gesture, so call this directly from the click
 * or key handler, before doing any slow work to produce the file contents, then pass the finished contents to
 * target.write(blob) whenever they're ready.
 *
 * Where the File System Access API isn't available (Firefox, Safari), the target falls back to a normal browser
 * download of suggestedName.
 *
 * options - Object with these fields:
 *     suggestedName - Default filename offered to the user
 *     description   - Human-readable name of the file type, e.g. "CSV file"
 *     mimeType      - e.g. "text/csv"
 *     extension     - e.g. ".csv"
 */
function pickSaveFile(options) {
    if (typeof window.showSaveFilePicker !== "function") {
        return Promise.resolve({
            write: function(blob) {
                let anchor = document.createElement("a");

                anchor.download = options.suggestedName;
                anchor.href = window.URL.createObjectURL(blob);
                anchor.click();

                // Give the browser time to start the download before releasing the blob
                setTimeout(function() {
                    window.URL.revokeObjectURL(anchor.href);
                }, 10000);

                return Promise.resolve();
            },
        });
    }

    let accept = {};

    accept[options.mimeType] = [options.extension];

    return window.showSaveFilePicker({
        suggestedName: options.suggestedName,
        types: [{description: options.description, accept: accept}],
    }).then(function(fileHandle) {
        return {
            write: function(blob) {
                return fileHandle.createWritable().then(function(writable) {
                    return writable.write(blob).then(function() {
                        return writable.close();
                    });
                });
            },
        };
    }, function(error) {
        // The user dismissing the picker isn't an error worth reporting
        if (error && error.name === "AbortError") {
            return null;
        }

        throw error;
    });
}

/**
 * Returns the loaded log's filename with its extension removed, or fallback if no log is loaded.
 */
function getLogBaseFilename(fallback) {
    let logFilename = $(".log-filename").text().trim();

    return logFilename ? logFilename.replace(/\.[^.]*$/, "") : fallback;
}
