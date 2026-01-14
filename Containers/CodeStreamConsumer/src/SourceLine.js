class SourceLine {
    constructor(lineNumber, content) {
        this.lineNumber = Number(lineNumber) || 0;
        this.content = (typeof content === 'string') ? content : String(content || '');
    }

    getContent() {
        return this.content;
    }

    // true when the trimmed content is non-empty
    hasContent() {
        return typeof this.content === 'string' && this.content.trim().length > 0;
    }

    // equality used by chunkMatch: exact string equality
    equals(other) {
        if (!other || typeof other.getContent !== 'function') return false;
        return this.getContent() === other.getContent();
    }

    toString() {
        return `${this.lineNumber}: ${this.content}`;
    }
}

module.exports = SourceLine;
