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
 
// Express and Formidable stuff to receice a file for further processing
// --------------------
const form = formidable({multiples:false});

app.post('/', fileReceiver );
function fileReceiver(req, res, next) {
    form.parse(req, (err, fields, files) => {
        fs.readFile(files.data.filepath, { encoding: 'utf8' })
            .then( data => { return processFile(fields.name, data); });
    });
    return res.end('');
}

app.get('/', viewClones );
app.get('/timers', viewTimers );
app.get('/timers/data', (req, res) => {
    const data = FILE_TIMERS.map((r, idx) => ({
        idx,
        ts: r.ts,
        name: r.name,
        totalMs: Number(r.total) / 1_000_000,
        matchMs: Number(r.match) / 1_000_000,
        lines: r.lines || 0,
        candidateSearchMs: r.candidateSearch ? Number(r.candidateSearch) / 1_000_000 : 0,
        expandMs: r.expand ? Number(r.expand) / 1_000_000 : 0,
        consolidateMs: r.consolidate ? Number(r.consolidate) / 1_000_000 : 0
    }));
    res.json(data);
});

const server = app.listen(PORT, () => { console.log('Listening for files on port', PORT); });


// Page generation for viewing current progress
// --------------------
function getStatistics() {
    let cloneStore = CloneStorage.getInstance();
    let fileStore = FileStorage.getInstance();
    // include comparisons & chunk size
    const comparisons = CloneDetector.getComparisonCount ? CloneDetector.getComparisonCount() : 0;
    const chunkSize = CloneDetector.getChunkSize ? CloneDetector.getChunkSize() : '(unknown)';
    let output = 'Processed ' + fileStore.numberOfFiles + ' files containing ' + cloneStore.numberOfClones + ' clones. ';
    output += 'Chunk size: ' + chunkSize + '. Comparisons: ' + comparisons + '.';
     return output;
}

function lastFileTimersHTML() {
    if (!lastFile) return '';
    output = '<p>Timers for last file processed:</p>\n<ul>\n'
    let timers = Timer.getTimers(lastFile);
    for (t in timers) {
        output += '<li>' + t + ': ' + (timers[t] / (1000n)) + ' µs\n'
    }
    output += '</ul>\n';
    return output;
}

function listClonesHTML() {
    const cs = CloneStorage.getInstance();
    const clones = cs.getClones() || [];

    let output = '<HR>\n<H2>Found Clones</H2>\n';
    output += `<P>Total clones: ${clones.length}</P>\n`;

    if (clones.length === 0) {
        output += '<P>No clones detected yet.</P>\n';
        return output;
    }

    output += '<ul>\n';
    for (const c of clones) {
        // show only source file and source range and target count
        output += `<li><strong>${c.sourceName}</strong> [${c.sourceStart}-${c.sourceEnd}] — targets: ${c.targets.length}</li>\n`;
    }
    output += '</ul>\n';
    return output;
}

function listProcessedFilesHTML() {
    let fs = FileStorage.getInstance();
    let output = '<HR>\n<H2>Processed Files</H2>\n'
    output += fs.filenames.reduce( (out, name) => {
        out += '<li>' + name + '\n';
        return out;
    }, '<ul>\n');
    output += '</ul>\n';
    return output;
}

// Helper: render SVG polyline chart for totals (ms)
function renderSvgChart(samples, width=800, height=200) {
    if (!samples || samples.length === 0) return '<div>No data</div>';
    const pad = 30;
    const w = width, h = height;
    const vals = samples.map(s => Number(s.total) / 1_000_000);
    const maxv = Math.max(...vals, 1);
    const minv = Math.min(...vals);
    const n = vals.length;
    const points = vals.map((v,i) => {
        const x = pad + (i * (w - 2*pad) / Math.max(1,n-1));
        const y = pad + (1 - ( (v - minv) / (maxv - minv + 1e-9) )) * (h - 2*pad);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    // basic axes and polyline
    const axisY = `
        <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h-pad}" stroke="#888" stroke-width="1"/>
        <line x1="${pad}" y1="${h-pad}" x2="${w-pad}" y2="${h-pad}" stroke="#888" stroke-width="1"/>
    `;
    const labels = `
        <text x="${pad}" y="${pad-8}" font-size="10" fill="#000">${maxv.toFixed(2)} ms</text>
        <text x="${pad}" y="${h-pad+14}" font-size="10" fill="#000">${minv.toFixed(2)} ms</text>
    `;
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      ${axisY}
      <polyline points="${points}" fill="none" stroke="#007acc" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${labels}
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
        // big SVG chart (last up to MAX_TIMER_RECORDS)
        page += renderSvgChart(FILE_TIMERS.slice(-Math.min(MAX_TIMER_RECORDS, 5000)));
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
             FILE_TIMERS.push({
                 ts: Date.now(),
                 name: file.name,
                 lines: Array.isArray(file.lines) ? file.lines.length : 0,
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
