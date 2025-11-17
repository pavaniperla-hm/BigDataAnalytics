const emptyLine = /^\s*$/;
const oneLineComment = /\/\/.*/;
const oneLineMultiLineComment = /\/\*.*?\*\//;
const openMultiLineComment = /\/\*+[^\*\/]*$/;
const closeMultiLineComment = /^[\*\/]*\*+\//;

const SourceLine = require('./SourceLine');
const FileStorage = require('./FileStorage');
const Clone = require('./Clone');

const DEFAULT_CHUNKSIZE = 5;

class CloneDetector {
    #myChunkSize = process.env.CHUNKSIZE || DEFAULT_CHUNKSIZE;
    #myFileStore = FileStorage.getInstance();

    static #processedFiles = 0;

    constructor() {
    }

    // Private Methods
    // --------------------
    #filterLines(file) {
        // Split into lines and remove comments / empty lines while keeping line numbers
        let rawLines = file.contents.split('\n');
        let inMultiLineComment = false;
        file.lines = [];

        for (let i = 0; i < rawLines.length; i++) {
            let ln = rawLines[i];
            // Handle start/end of multiline comments that may span lines
            if (inMultiLineComment) {
                // Check for end
                if (closeMultiLineComment.test(ln)) {
                    // Remove everything up to the end token
                    const idx = ln.search(closeMultiLineComment);
                    ln = ln.slice(idx + RegExp.lastMatch.length);
                    inMultiLineComment = false;
                } else {
                    // Entire line in comment -> produce empty SourceLine placeholder
                    file.lines.push(new SourceLine(i + 1, ''));
                    continue;
                }
            }

            // Remove single-line /* ... */ occurrences first
            ln = ln.replace(oneLineMultiLineComment, '');

            // Remove single-line // comments
            ln = ln.replace(oneLineComment, '');

            // If line starts a multi-line comment that doesn't end on same line
            if (openMultiLineComment.test(ln) && !closeMultiLineComment.test(ln)) {
                // Strip from start of comment
                const idx = ln.search(openMultiLineComment);
                ln = ln.slice(0, idx);
                inMultiLineComment = true;
            } else if (openMultiLineComment.test(ln) && closeMultiLineComment.test(ln)) {
                // inline open and close on same line: remove the comment portion
                ln = ln.replace(/\/\*[\s\S]*?\*\//g, '');
            }

            // Trim trailing/leading whitespace
            const content = ln.replace(/\s+$/g, '').replace(/^\s+/g, '');

            // Insert SourceLine: keep empty lines (so lineNumbers are preserved)
            file.lines.push(new SourceLine(i + 1, content));
        }

        return file;
    }

    #getContentLines(file) {
        // Return only SourceLine objects that actually contain content
        return (file.lines || []).filter(l => l && l.hasContent && l.hasContent());
    }


    #chunkify(file) {
        // Build overlapping chunks of size #myChunkSize from content lines
        const size = Number(this.#myChunkSize);
        const contentLines = this.#getContentLines(file);
        file.chunks = [];

        if (contentLines.length < size) return file;

        for (let i = 0; i <= contentLines.length - size; i++) {
            const chunk = contentLines.slice(i, i + size);
            file.chunks.push(chunk);
        }

        return file;
    }

    #chunkMatch(first, second) {
        // Exact content match for all lines in the chunk
        if (!Array.isArray(first) || !Array.isArray(second)) return false;
        if (first.length !== second.length) return false;

        for (let i = 0; i < first.length; i++) {
            if (!first[i].equals(second[i])) return false;
        }
        return true;
    }

    #filterCloneCandidates(file, compareFile) {
        // Generate Clone instances for matching chunks between file and compareFile
        const newInstances = [];

        // skip self comparison
        if (!compareFile || compareFile.name === file.name) return newInstances;

        const fChunks = file.chunks || [];
        const cChunks = compareFile.chunks || [];

        for (let i = 0; i < fChunks.length; i++) {
            const fChunk = fChunks[i];
            for (let j = 0; j < cChunks.length; j++) {
                const cChunk = cChunks[j];
                if (this.#chunkMatch(fChunk, cChunk)) {
                    // create a Clone instance: source=file.name, target=compareFile.name
                    const clone = new Clone(file.name, compareFile.name, fChunk, cChunk);
                    newInstances.push(clone);
                }
            }
        }

        return newInstances;
    }

    #expandCloneCandidates(file) {
        // Expand adjacent matching chunks into longer clones
        if (!file.instances || file.instances.length === 0) return file;

        // Sort by sourceStart to try to expand consecutive chunks
        file.instances.sort((a, b) => a.sourceStart - b.sourceStart);

        const expanded = [];
        for (const inst of file.instances) {
            if (expanded.length === 0) {
                expanded.push(inst);
                continue;
            }
            const last = expanded[expanded.length - 1];
            // If last can be expanded with current instance, merge them (and combine targets)
            if (last.maybeExpandWith(inst)) {
                last.addTarget(inst);
            } else {
                expanded.push(inst);
            }
        }

        file.instances = expanded;
        return file;
    }

    #consolidateClones(file) {
        // Remove duplicates (same source range) and merge their targets
        if (!file.instances || file.instances.length === 0) return file;

        const consolidated = [];
        for (const inst of file.instances) {
            const existing = consolidated.find(c => c.equals(inst));
            if (existing) {
                existing.addTarget(inst);
            } else {
                consolidated.push(inst);
            }
        }

        file.instances = consolidated;
        return file;
    }


    // Public Processing Steps
    // --------------------
    preprocess(file) {
        // Create file.lines and filter comments/empty lines as placeholders
        return this.#filterLines(file);
    }

    transform(file) {
        // Turn source lines into chunks for matching
        return this.#chunkify(file);
    }

    matchDetect(file) {
        // Compare this file's chunks against all previously stored files and build instances
        const candidates = [];

        for (const otherFile of this.#myFileStore.getAllFiles()) {
            // ensure the other file has been transformed
            if (!otherFile.chunks) continue;
            const found = this.#filterCloneCandidates(file, otherFile);
            if (found && found.length > 0) {
                candidates.push(...found);
            }
        }

        file.instances = candidates;
        // Try expanding adjacent chunks into longer clones
        this.#expandCloneCandidates(file);
        // Consolidate duplicate clones merging targets
        this.#consolidateClones(file);

        return file;
    }

    pruneFile(file) {
        // Reduce memory: remove full contents but retain lines/chunks/instances
        try { delete file.contents; } catch (e) {}
        return file;
    }

    storeFile(file) {
        // Store file in FileStorage for future comparisons and increment processed counter
        const stored = this.#myFileStore.storeFile(file);
        CloneDetector.#processedFiles++;
        return stored;
    }

    get numberOfProcessedFiles() { return CloneDetector.#processedFiles; }
}

module.exports = CloneDetector;
