const express = require('express');
const formidable = require('formidable');
const fs = require('fs/promises');
const app = express();
const PORT = 3000;

const Timer = require('./Timer');
const CloneDetector = require('./CloneDetector');
const CloneStorage = require('./CloneStorage');
const FileStorage = require('./FileStorage');


const FILE_TIMERS = []; // recent timings
const MAX_TIMER_RECORDS = 500;
const os = require('os');
// Track lifecycle timestamps
let FIRST_FILE_TS = null;      // when first file was received
let LAST_CLONE_TS = null;      // when last clone was found
let LAST_FILE_TS = null;       // when last file finished processing

function formatTs(ts) { return ts ? new Date(ts).toISOString() : 'N/A'; }

// added helper to return concise runtime statistics used by the pages
function getStatistics() {
    try {
        const cloneStore = CloneStorage.getInstance ? CloneStorage.getInstance() : { numberOfClones: 0 };
        const fileStore = FileStorage.getInstance ? FileStorage.getInstance() : { numberOfFiles: 0 };
        const processed = fileStore.numberOfFiles || fileStore.numberOfFilesProcessed || 0;
        const clones = cloneStore.numberOfClones || 0;
        const chunkSize = (typeof CloneDetector.getChunkSize === 'function') ? CloneDetector.getChunkSize() : (process.env.CHUNKSIZE || DEFAULT_CHUNKSIZE);
        const comparisons = (typeof CloneDetector.getComparisonCount === 'function') ? CloneDetector.getComparisonCount() : 0;
        const indexSize = (typeof CloneDetector.getIndexSize === 'function') ? CloneDetector.getIndexSize() : 0;
        return `Processed ${processed} files containing ${clones} clones. Chunk size: ${chunkSize}. Comparisons: ${comparisons}. Index entries: ${indexSize}.`;
    } catch (e) {
        return 'Statistics unavailable';
    }
}
 
// Express and Formidable stuff to receice a file for further processing
// --------------------
const form = formidable({multiples:false});

app.post('/', fileReceiver );

async function fileReceiver(req, res, next) {
    const form = new formidable.IncomingForm();
    form.parse(req, async (err, fields, files) => {
        if (err) {
            console.error('form parse error', err);
            res.status(400).end('parse error');
            return;
        }

        const fileObj = files && (files.data || files.file || files.upload);
        if (!fileObj || !fileObj.filepath) {
            console.warn('No uploaded file in request', { fields, files });
            res.status(400).end('no file uploaded');
            return;
        }

        try {
            const data = await fs.readFile(fileObj.filepath, { encoding: 'utf8' });
            // wait for processing to finish to avoid unbounded concurrency
            await processFile(fields.name || fileObj.originalFilename || 'uploaded', data);
            res.status(200).end('OK');
        } catch (e) {
            console.error('processing error', e);
            res.status(500).end('processing error');
        }
    });
}

app.get('/', viewClones );
app.get('/timers', viewTimers );
// New: return JSON data for external plotting / quick inspection
app.get('/timers/data', (req, res) => {
    const data = FILE_TIMERS.map((r, idx) => ({
        idx,
        ts: r.ts,
        name: r.name,
        totalMs: Number(r.total) / 1_000_000,
        matchMs: Number(r.match) / 1_000_000,
        expandMs: r.expand ? Number(r.expand) / 1_000_000 : 0,
        candidateSearchMs: r.candidateSearch ? Number(r.candidateSearch) / 1_000_000 : 0,
        consolidateMs: r.consolidate ? Number(r.consolidate) / 1_000_000 : 0,
        lines: r.lines || 0,
        chunks: r.chunks || 0,
        avgCloneChunks: r.avgCloneChunks || 0
    }));
    res.json(data);
});

// Helper: render SVG polyline chart for a chosen metric (metric: 'total'|'match'|'expand'|'candidateSearch')
function renderSvgChart(samples, metric='total', width=800, height=200) {
    if (!samples || samples.length === 0) return '<div>No data</div>';
    const pad = 40;
    const w = width, h = height;
    const vals = samples.map(s => {
        switch(metric) {
            case 'expand': return s.expand ? Number(s.expand) / 1_000_000 : 0;
            case 'match': return s.match ? Number(s.match) / 1_000_000 : 0;
            case 'candidateSearch': return s.candidateSearch ? Number(s.candidateSearch) / 1_000_000 : 0;
            default: return Number(s.total) / 1_000_000;
        }
    });
    const maxv = Math.max(...vals, 1);
    const minv = Math.min(...vals, 0);
    const n = vals.length;

    // compute X base index using total processed files so labels are absolute file numbers
    const totalProcessed = (FileStorage.getInstance && FileStorage.getInstance().numberOfFiles) || n;
    const baseIndex = Math.max(1, totalProcessed - n + 1);

    const points = vals.map((v,i) => {
        const x = pad + (i * (w - 2*pad) / Math.max(1,n-1));
        const y = pad + (1 - ((v - minv) / (maxv - minv + 1e-9))) * (h - 2*pad);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');

    // Y ticks (4 ticks)
    const yTicks = 4;
    let yTicksHtml = '';
    for (let t=0; t<=yTicks; t++) {
        const frac = t / yTicks;
        const val = (maxv - minv) * (1 - frac) + minv;
        const y = pad + frac * (h - 2*pad);
        yTicksHtml += `<line x1="${pad-6}" y1="${y.toFixed(2)}" x2="${w-pad}" y2="${y.toFixed(2)}" stroke="#eee" stroke-width="1"/>`;
        yTicksHtml += `<text x="${6}" y="${(y+4).toFixed(2)}" font-size="10" fill="#000">${val.toFixed(3)} ms</text>`;
    }

    // X ticks (5 ticks)
    const xTicks = Math.min(5, Math.max(2, n));
    let xTicksHtml = '';
    for (let k=0; k<xTicks; k++) {
        const i = Math.round(k * (n-1) / (xTicks-1));
        const x = pad + (i * (w - 2*pad) / Math.max(1,n-1));
        const label = baseIndex + i;
        xTicksHtml += `<line x1="${x.toFixed(2)}" y1="${h-pad}" x2="${x.toFixed(2)}" y2="${h-pad+6}" stroke="#888" stroke-width="1"/>`;
        xTicksHtml += `<text x="${(x-10).toFixed(2)}" y="${(h-pad+20).toFixed(2)}" font-size="10" fill="#000">${label}</text>`;
    }

    const axis = `
        <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h-pad}" stroke="#888" stroke-width="1"/>
        <line x1="${pad}" y1="${h-pad}" x2="${w-pad}" y2="${h-pad}" stroke="#888" stroke-width="1"/>
    `;

    const ylabel = metric === 'expand' ? 'Expand time (ms)' : (metric === 'candidateSearch' ? 'Candidate search (ms)' : (metric === 'match' ? 'Match (ms)' : 'Processing time (ms)'));

    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      ${axis}
      ${yTicksHtml}
      ${xTicksHtml}
      <polyline points="${points}" fill="none" stroke="#007acc" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <text x="${w/2}" y="${h-6}" font-size="11" fill="#000" text-anchor="middle">Files processed (file index)</text>
      <text x="12" y="${pad-12}" font-size="11" fill="#000">${ylabel}</text>
    </svg>`;
}

// Helper: small sparkline for main page
function renderSparkline(samples, width=200, height=40) {
    if (!samples || samples.length === 0) return '';
    const pad = 2;
    const w = width, h = height;
    const vals = samples.map(s => Number(s.total) / 1_000_000);
    const maxv = Math.max(...vals, 1);
    const minv = Math.min(...vals);
    const n = vals.length;
    const points = vals.map((v,i) => {
        const x = pad + (i * (w - 2*pad) / Math.max(1,n-1));
        const y = pad + (1 - ( (v - minv) / (maxv - minv + 1e-9) )) * (h - 2*pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      <polyline points="${points}" fill="none" stroke="#007acc" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

function viewClones(req, res, next) {
    let page='<HTML><HEAD><TITLE>CodeStream Clone Detector</TITLE></HEAD>\n';
    page += '<BODY><H1>CodeStream Clone Detector</H1>\n';
    page += '<P>' + getStatistics() + '</P>\n';
    // lifecycle timestamps
    page += `<P>First file received: ${formatTs(FIRST_FILE_TS)}</P>\n`;
    page += `<P>Last clone found   : ${formatTs(LAST_CLONE_TS)}</P>\n`;
    page += `<P>Last file processed: ${formatTs(LAST_FILE_TS)}</P>\n`;
    // show averages computed from recent samples
    const n = FILE_TIMERS.length;
    if (n > 0) {
        const totalsMs = FILE_TIMERS.map(r => Number(r.total) / 1_000_000);
        const matchMs = FILE_TIMERS.map(r => Number(r.match) / 1_000_000);
        const perLineUs = FILE_TIMERS.map(r => r.lines ? ((Number(r.total) / 1000) / r.lines) : 0);
        const avg = arr => arr.reduce((s,v) => s+v, 0) / arr.length;
        page += `<P>Recent samples: ${n}. Avg total ${avg(totalsMs).toFixed(3)} ms, Avg match ${avg(matchMs).toFixed(3)} ms, Avg µs/line ${avg(perLineUs).toFixed(3)}</P>\n`;
        // small sparkline
        page += renderSparkline(FILE_TIMERS.slice(-100));
        page += `<P><a href="/timers">Show detailed timing chart</a> | <a href="/timers/data">Download JSON</a></P>\n`;
    } else {
        page += '<P>No timing samples yet.</P>\n';
    }
    page += lastFileTimersHTML() + '\n';
    page += listClonesHTML() + '\n';
    page += '</BODY></HTML>';
    res.send(page);
}

// New: timers trends page
function viewTimers(req, res, next) {
    let page='<HTML><HEAD><TITLE>CodeStream Timers</TITLE></HEAD>\n';
    page += '<BODY><H1>CodeStream Timers</H1>\n';
    page += '<P>' + getStatistics() + '</P>\n';
    // compute summary stats
    const n = FILE_TIMERS.length;
    if (n > 0) {
        // totals in ms, per-line in µs
        const totalsMs = FILE_TIMERS.map(r => Number(r.total) / 1_000_000);
        const perLineUs = FILE_TIMERS.map(r => r.lines ? (Number(r.total)/1000) / r.lines : 0);

        const avg = arr => arr.reduce((s,v) => s+v, 0) / arr.length;
        const median = arr => {
            const a = arr.slice().sort((x,y)=>x-y);
            const m = Math.floor(a.length/2);
            return (a.length % 2) ? a[m] : ((a[m-1] + a[m]) / 2);
        };

        page += `<P>Recent samples: ${n}. Avg total ${avg(totalsMs).toFixed(3)} ms, median total ${median(totalsMs).toFixed(3)} ms. Avg µs/line ${avg(perLineUs).toFixed(3)}, median µs/line ${median(perLineUs).toFixed(3)}.</P>\n`;
        // big SVG chart (last up to MAX_TIMER_RECORDS) - total
        page += '<H3>Processing time trend</H3>\n';
        page += renderSvgChart(FILE_TIMERS.slice(-Math.min(MAX_TIMER_RECORDS, 5000)), 'total');
        page += '<HR/>\n';
        // expand trend
        page += '<H3>Expand phase time trend</H3>\n';
        page += renderSvgChart(FILE_TIMERS.slice(-Math.min(MAX_TIMER_RECORDS, 5000)), 'expand');
        page += '<HR/>\n';
    } else {
        page += '<P>No timing samples yet.</P>\n';
    }
    page += '<H2>Recent file timings (most recent first)</H2>\n';
    page += '<table border="1"><tr><th>Time</th><th>File</th><th>Lines</th><th>Total ms</th><th>Match ms</th><th>Total µs/line</th></tr>\n';
     for (const rec of FILE_TIMERS.slice().reverse()) {
        const totalMs = Number(rec.total) / 1_000_000;
        const matchMs = Number(rec.match) / 1_000_000;
        const perLineUs = rec.lines ? ((Number(rec.total) / 1000) / rec.lines).toFixed(3) : '0';
        page += `<tr><td>${new Date(rec.ts).toISOString()}</td><td>${rec.name}</td><td>${rec.lines}</td><td>${totalMs.toFixed(3)}</td><td>${matchMs.toFixed(3)}</td><td>${perLineUs}</td></tr>\n`;
     }
     page += '</table>\n';
     page += '</BODY></HTML>';
     res.send(page);
 }
 
 // Some helper functions
// --------------------
// PASS is used to insert functions in a Promise stream and pass on all input parameters untouched.
PASS = fn => d => {
    try {
        fn(d);
        return d;
    } catch (e) {
        throw e;
    }
};

const STATS_FREQ = 100;
const URL = process.env.URL || 'http://localhost:8080/';
var lastFile = null;

function maybePrintStatistics(file, cloneDetector, cloneStore) {
    if (0 == cloneDetector.numberOfProcessedFiles % STATS_FREQ) {
        console.log('Processed', cloneDetector.numberOfProcessedFiles, 'files and found', cloneStore.numberOfClones, 'clones.');
        let timers = Timer.getTimers(file);
        let str = 'Timers for last file processed: ';
        for (t in timers) {
            str += t + ': ' + (timers[t] / (1000n)) + ' µs '
        }
        console.log(str);
        console.log('List of found clones available at', URL);
    }

    return file;
}

// Processing of the file
// --------------------
function processFile(filename, contents) {
    let cd = new CloneDetector();
    let cloneStore = CloneStorage.getInstance();
 
    return Promise.resolve({name: filename, contents: contents} )
        .then( (file) => Timer.startTimer(file, 'total') )
        .then( (file) => cd.preprocess(file) )
        .then( (file) => cd.transform(file) )
 
        .then( (file) => Timer.startTimer(file, 'match') )
        .then( (file) => cd.matchDetect(file) )
        .then( (file) => cloneStore.storeClones(file) )
        .then( (file) => Timer.endTimer(file, 'match') )
 
        .then( (file) => cd.storeFile(file) )
        .then( (file) => Timer.endTimer(file, 'total') )
        .then( PASS( (file) => lastFile = file ))
        .then( PASS( (file) => {
            // Capture timers for trends page (include sub-timers if present)
            const timers = Timer.getTimers(file) || {};

            // lifecycle updates
            if (!FIRST_FILE_TS) FIRST_FILE_TS = Date.now();
            if (file.instances && file.instances.length > 0) LAST_CLONE_TS = Date.now();
            LAST_FILE_TS = Date.now();

            // compute avg clone size in chunks (best-effort) and robust chunk count
            let avgCloneChunks = 0;

            // derive number of non-empty content lines robustly (fallback if SourceLine.hasContent behaves unexpectedly)
            const contentLinesArray = (file.lines || []).filter(l => {
                if (!l) return false;
                if (typeof l.hasContent === 'function') return l.hasContent();
                if (typeof l.getContent === 'function') return (String(l.getContent() || '').trim().length > 0);
                // fallback: treat as non-empty if string value is non-whitespace
                return String(l).trim().length > 0;
            });
            const contentLineCount = contentLinesArray.length;

            const chunkSize = CloneDetector.getChunkSize ? CloneDetector.getChunkSize() : Number(process.env.CHUNKSIZE || 5);
            // number of overlapping chunks = max(0, contentLines - chunkSize + 1)
            const chunksCount = Math.max(0, contentLineCount - chunkSize + 1);

            if (Array.isArray(file.instances) && file.instances.length > 0) {
                const cs = [];
                for (const inst of file.instances) {
                    if (inst && inst.sourceStart != null && inst.sourceEnd != null) {
                        const lines = Number(inst.sourceEnd) - Number(inst.sourceStart) + 1;
                        cs.push(Math.max(1, Math.ceil(lines / chunkSize)));
                    } else if (inst && inst.sourceLength != null) {
                        cs.push(Math.max(1, Math.ceil(Number(inst.sourceLength) / chunkSize)));
                    } else {
                        cs.push(1);
                    }
                }
                avgCloneChunks = cs.reduce((s,v) => s+v, 0) / cs.length;
            }

            // debug: log suspicious cases where file has many lines but zero chunks
            if (chunksCount === 0 && (file.lines || []).length > 0 && (file.lines || []).length >= chunkSize) {
                console.debug(`Warning: file ${file.name} has ${file.lines.length} lines but computed chunks=0 (contentLines=${contentLineCount}, CHUNKSIZE=${chunkSize}). Check SourceLine.hasContent/comment stripping.`);
            }

            FILE_TIMERS.push({
                ts: Date.now(),
                name: file.name,
                lines: Array.isArray(file.lines) ? file.lines.length : 0,
                chunks: chunksCount,
                avgCloneChunks: avgCloneChunks,
                total: timers.total || 0n,
                match: timers.match || 0n,
                candidateSearch: timers.candidateSearch || 0n,
                expand: timers.expand || 0n,
                consolidate: timers.consolidate || 0n
            });
            if (FILE_TIMERS.length > MAX_TIMER_RECORDS) FILE_TIMERS.shift();
            return file;
        }))
         .then( PASS( (file) => maybePrintStatistics(file, cd, cloneStore) ))
         .catch( console.log );
};


/*
1. Preprocessing: Remove uninteresting code, determine source and comparison units/granularities
2. Transformation: One or more extraction and/or transformation techniques are applied to the preprocessed code to obtain an intermediate representation of the code.
3. Match Detection: Transformed units (and/or metrics for those units) are compared to find similar source units.
4. Formatting: Locations of identified clones in the transformed units are mapped to the original code base by file location and line number.
5. Post-Processing and Filtering: Visualisation of clones and manual analysis to filter out false positives
6. Aggregation: Clone pairs are aggregated to form clone classes or families, in order to reduce the amount of data and facilitate analysis.
*/

const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`Listening on ${HOST}:${PORT}`);
});

// Render timers for the last processed file (used by viewClones)
function lastFileTimersHTML() {
    try {
        if (FILE_TIMERS.length === 0) return '<P>No timing samples yet.</P>';
        const rec = FILE_TIMERS[FILE_TIMERS.length - 1];
        const totalUs = rec.total ? (Number(rec.total) / 1000) : 0;
        const matchUs = rec.match ? (Number(rec.match) / 1000) : 0;
        const candUs = rec.candidateSearch ? (Number(rec.candidateSearch) / 1000) : 0;
        const expandUs = rec.expand ? (Number(rec.expand) / 1000) : 0;
        const consUs = rec.consolidate ? (Number(rec.consolidate) / 1000) : 0;
        return `<H3>Timers for last file processed:</H3>
            <UL>
              <LI>total: ${Math.round(totalUs)} µs</LI>
              <LI>match: ${Math.round(matchUs)} µs</LI>
              <LI>candidateSearch: ${Math.round(candUs)} µs</LI>
              <LI>expand: ${Math.round(expandUs)} µs</LI>
              <LI>consolidate: ${Math.round(consUs)} µs</LI>
            </UL>`;
    } catch (e) {
        return '<P>Timers unavailable</P>';
    }
}

// Minimal clone listing placeholder (safe even if CloneStorage API varies)
function listClonesHTML() {
    try {
        const cs = CloneStorage && CloneStorage.getInstance ? CloneStorage.getInstance() : null;
        let count = 0;
        if (cs) {
            if (typeof cs.numberOfClones === 'number') count = cs.numberOfClones;
            else if (typeof cs.getAll === 'function') {
                const all = cs.getAll();
                count = Array.isArray(all) ? all.length : 0;
            }
        }
        return `<H2>Found Clones</H2><P>Total clones: ${count}</P>`;
    } catch (e) {
        return '<H2>Found Clones</H2><P>Unavailable</P>';
    }
}
