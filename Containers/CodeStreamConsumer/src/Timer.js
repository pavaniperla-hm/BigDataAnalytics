class Timer {
    // Timer Management
    // --------------------
    static startTimer(file, timerName) {
        // use an object for named timers and ensure it's always present
        file.timers = file.timers || {};
        file.timers[timerName] = process.hrtime.bigint();
        return file;
    }

    static endTimer(file, timerName) {
        let end = process.hrtime.bigint();
        let start = (file.timers && file.timers[timerName]) || end;
        file.timers = file.timers || {};
        file.timers[timerName] = end - start;
        return file;
    }

    static getTimers(file) { return file.timers || {}; }
}

module.exports = Timer;
