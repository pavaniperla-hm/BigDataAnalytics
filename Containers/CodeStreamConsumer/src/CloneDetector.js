const crypto = require('crypto');

const emptyLine = /^\s*$/;
const oneLineComment = /\/\/.*/;
const oneLineMultiLineComment = /\/\*.*?\*\//;
const openMultiLineComment = /\/\*+[^\*\/]*$/;
const closeMultiLineComment = /^[\*\/]*\*+\//;

const SourceLine = require('./SourceLine');
const FileStorage = require('./FileStorage');
const Clone = require('./Clone');
const Timer = require('./Timer');

const DEFAULT_CHUNKSIZE = 5;

class CloneDetector {
    #myChunkSize = process.env.CHUNKSIZE || DEFAULT_CHUNKSIZE;
    #myFileStore = FileStorage.getInstance();

    // total number of chunk-to-chunk comparisons performed so far
    static #comparisonCount = 0;
    static getComparisonCount() { return CloneDetector.#comparisonCount; }
    // convenience: current effective chunk size
    static getChunkSize() { return Number(process.env.CHUNKSIZE || DEFAULT_CHUNKSIZE); }

    // inverted index: Map<hash, Array<{ name, chunkIndex, chunk }>>

    static #invertedIndex = new Map();

    static #processedFiles = 0;

    constructor() {
    }

    // --- Helpers for indexing / hashing ---
    #hashChunk(chunk) {
        // Use chunk content (preserving order) as hash input
        const s = chunk.map(l => l.getContent()).join('\n');
        return crypto.createHash('sha1').update(s).digest('hex');
    }

    #indexAddFile(file) {
        const chunks = file.chunks || [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const h = this.#hashChunk(chunk);
            const arr = CloneDetector.#invertedIndex.get(h) || [];
            arr.push({ name: file.name, chunkIndex: i, chunk });
            CloneDetector.#invertedIndex.set(h, arr);
        }
    }

    static getIndexSize() {
        return CloneDetector.#invertedIndex.size;
    }

    // Private Methods
    // --------------------
    #filterLines(file) {
        // Safer approach:
        // 1) Remove all /* ... */ regions while preserving line counts (replace multiline matches with same number of newlines)
        // 2) Remove // comments (to end of line)
        // 3) Split into lines and keep original line numbers (empty lines are kept)
        let contents = String(file.contents || '');

        // Remove /* ... */ matches but preserve newline count so line numbers stay aligned
        contents = contents.replace(/\/\*[\s\S]*?\*\//g, (m) => {
            const nl = (m.match(/\n/g) || []).length;
            return nl > 0 ? '\n'.repeat(nl) : '';
        });

        // Remove // comments (to end of line) - use multiline flag
        contents = contents.replace(/\/\/.*$/gm, '');

        const rawLines = contents.split('\n');
        file.lines = rawLines.map((ln, idx) => {
            const content = String(ln).replace(/\s+$/g, '').replace(/^\s+/g, '');
            return new SourceLine(idx + 1, content);
        });

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

    // find candidates using the inverted index (hash -> bucket)
    #findCandidatesUsingIndex(file) {
        const newInstances = [];
        if (!file.chunks || file.chunks.length === 0) return newInstances;

        for (let i = 0; i < file.chunks.length; i++) {
            const fChunk = file.chunks[i];
            const h = this.#hashChunk(fChunk);
            const bucket = CloneDetector.#invertedIndex.get(h) || [];

            for (const entry of bucket) {
                // skip same-file entries
                if (entry.name === file.name) continue;
                // count the verification and verify content to avoid false positives
                CloneDetector.#comparisonCount++;
                if (this.#chunkMatch(fChunk, entry.chunk)) {
                    const clone = new Clone(file.name, entry.name, fChunk, entry.chunk);
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
        // Use inverted index to find candidates efficiently
        Timer.startTimer(file, 'candidateSearch');
        const candidates = this.#findCandidatesUsingIndex(file);
        Timer.endTimer(file, 'candidateSearch');

        file.instances = candidates;

        Timer.startTimer(file, 'expand');
        this.#expandCloneCandidates(file);
        Timer.endTimer(file, 'expand');

        Timer.startTimer(file, 'consolidate');
        this.#consolidateClones(file);
        Timer.endTimer(file, 'consolidate');

        return file;
    }

    pruneFile(file) {
        // Reduce memory: remove full contents but retain lines/chunks/instances
        try { delete file.contents; } catch (e) {}
        return file;
    }

    storeFile(file) {
        // Only index/store if not already processed
        if (!this.#myFileStore.isFileProcessed(file.name)) {
            this.#myFileStore.storeFile(file);
            if (file.chunks && file.chunks.length > 0) {
                this.#indexAddFile(file);
            }
            CloneDetector.#processedFiles++;
        } else {
            // ensure file is present in storage (idempotent)
            this.#myFileStore.storeFile(file);
        }
        return file;
    }

    get numberOfProcessedFiles() { return CloneDetector.#processedFiles; }
}

module.exports = CloneDetector;
