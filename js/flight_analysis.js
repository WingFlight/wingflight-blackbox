"use strict";

/**
 * FlightAnalysis — a lightweight, self-contained flight-health analysis engine.
 *
 * Takes a single already-loaded FlightLog and produces a plain-language verdict
 * (a handful of status cards) plus a set of "labs" — Governor, Power, Battery,
 * Vibration and PID Tracking — each with a narrative story and a few key
 * numbers. This is a scaled-down take on Blackbox_Lab's Labs/Verdict system,
 * adapted to this viewer's simpler, single-flight-in-front-of-you scope.
 *
 * Design notes:
 *  - Every number is computed only over a detected "stable flight" window
 *    (steady, governed hover/cruise), not the whole log, so spool-up/down and
 *    governor-target changes don't skew the numbers.
 *  - Every lab is independently gated: if the log doesn't have the fields it
 *    needs (or too little stable-flight data), it returns status "insufficient"
 *    with an explanatory story instead of guessing or showing NaN.
 */
var FlightAnalysis = (function() {

    var MIN_STABLE_SAMPLES = 100;

    // ------------------------------------------------------------------
    // Small math helpers
    // ------------------------------------------------------------------

    function average(values) {
        if (!values || !values.length) return null;
        var sum = 0;
        for (var i = 0; i < values.length; i++) sum += values[i];
        return sum / values.length;
    }

    function rms(values) {
        if (!values || !values.length) return null;
        var sum = 0;
        for (var i = 0; i < values.length; i++) sum += values[i] * values[i];
        return Math.sqrt(sum / values.length);
    }

    function maxOf(values) {
        var max = -Infinity;
        for (var i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
        return max;
    }

    function minOf(values) {
        var min = Infinity;
        for (var i = 0; i < values.length; i++) if (values[i] < min) min = values[i];
        return min;
    }

    function median(values) {
        if (!values || !values.length) return null;
        var sorted = values.slice(0).sort(function(a, b) { return a - b; });
        var mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function spread(array, lo, hi) {
        var min = Infinity, max = -Infinity;
        for (var i = lo; i <= hi; i++) {
            if (array[i] < min) min = array[i];
            if (array[i] > max) max = array[i];
        }
        return max - min;
    }

    function pickAtIndexes(array, indexes) {
        var result = new Array(indexes.length);
        for (var i = 0; i < indexes.length; i++) result[i] = array[indexes[i]];
        return result;
    }

    function insufficient(story) {
        return { status: "insufficient", story: story, metrics: [] };
    }

    // ------------------------------------------------------------------
    // Column extraction — read the whole log once into plain arrays keyed
    // by field name, tolerant of fields the log doesn't have.
    // ------------------------------------------------------------------

    var WANTED_FIELDS = [
        "motor1speed", "motor2speed",
        "headspeed", "tailspeed", // pre-rename field names -- still show up in real logs from before the motor1/2speed rename
        "govTarget", "govRequest",
        "setpoint[0]", "setpoint[1]", "setpoint[2]",
        "axisError[0]", "axisError[1]", "axisError[2]",
        "axisSum[0]", "axisSum[1]", "axisSum[2]",
        "gyroADC[0]", "gyroADC[1]", "gyroADC[2]",
        "rcCommand[4]",
        "Vbat", "Ibat",
        "EscV", "EscI", "EscThr", "EscCap",
        "motor[0]",
        "tvAxisP[0]", "tvAxisP[1]", "tvAxisP[2]",
        "tvAxisI[0]", "tvAxisI[1]", "tvAxisI[2]",
        "tvAxisD[0]", "tvAxisD[1]", "tvAxisD[2]",
        "tvAxisF[0]", "tvAxisF[1]", "tvAxisF[2]",
        "tvAxisB[0]", "tvAxisB[1]", "tvAxisB[2]",
        "flightModeFlags", "flightModeFlags2"
    ];

    // ------------------------------------------------------------------
    // Flying mask -- which samples are real flight. The stable-flight search
    // and the handling labs only look at these, so armed time on the ground,
    // closed-throttle glides and modes that drive the surfaces without the
    // gyro don't get graded as flight.
    // ------------------------------------------------------------------

    var FLYING_MIN_THROTTLE = 50;   // rcCommand[4] is 0..1000
    var BYPASS_MODES = ["GYRO OFF", "SETUP", "MANUAL", "PASSTHROUGH"];
    var LEVELING_MODES = ["ANGLE", "HORIZON", "TRAINER", "ATTHOLD", "GPSRESCUE", "RESCUE", "LOITER", "RTH", "FAILSAFE"];

    function modeBits(names) {
        var table = (typeof FLIGHT_LOG_FLIGHT_MODE_NAME !== "undefined") ? FLIGHT_LOG_FLIGHT_MODE_NAME : [];
        var bits = [];
        for (var i = 0; i < names.length; i++) {
            var bit = table.indexOf(names[i]);
            if (bit >= 0) bits.push(bit);
        }
        return bits;
    }

    // Mode flags as one per-sample boolean array (any of `bits` set), or null
    // when the log has no flags or none of the modes exist for this firmware.
    function modeMask(columns, bits) {
        var flags1 = columns.flightModeFlags, flags2 = columns.flightModeFlags2;
        if (!flags1 || !bits.length) return null;
        var mask = new Array(flags1.length);
        var last1 = null, last2 = null, lastValue = false;
        for (var i = 0; i < flags1.length; i++) {
            var w1 = flags1[i] || 0, w2 = flags2 ? (flags2[i] || 0) : 0;
            if (w1 !== last1 || w2 !== last2) {
                last1 = w1; last2 = w2; lastValue = false;
                for (var b = 0; b < bits.length; b++) {
                    var word = bits[b] < 32 ? w1 : w2;
                    if (Math.floor(word / Math.pow(2, bits[b] % 32)) % 2 === 1) { lastValue = true; break; }
                }
            }
            mask[i] = lastValue;
        }
        return mask;
    }

    function buildModeMasks(columns, n) {
        var armed = modeMask(columns, modeBits(["ARM"]));
        var bypass = modeMask(columns, modeBits(BYPASS_MODES));
        var leveling = modeMask(columns, modeBits(LEVELING_MODES));
        var throttle = columns["rcCommand[4]"];
        var flying = new Array(n);
        for (var i = 0; i < n; i++) {
            flying[i] = (!armed || armed[i]) && (!throttle || throttle[i] > FLYING_MIN_THROTTLE);
        }
        return { flying: flying, bypass: bypass, leveling: leveling };
    }

    function readColumns(flightLog, startTime, endTime) {
        var fieldIndexByName = {};
        var wanted = [];
        for (var i = 0; i < WANTED_FIELDS.length; i++) {
            var idx = flightLog.getMainFieldIndexByName(WANTED_FIELDS[i]);
            if (idx !== undefined) {
                fieldIndexByName[WANTED_FIELDS[i]] = idx;
                wanted.push(WANTED_FIELDS[i]);
            }
        }

        var timeFieldIndex = FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME;
        var chunks = flightLog.getChunksInTimeRange(
            startTime === undefined ? flightLog.getMinTime() : startTime,
            endTime === undefined ? flightLog.getMaxTime() : endTime
        );

        var sampleCount = 0;
        for (var c = 0; c < chunks.length; c++) sampleCount += chunks[c].frames.length;

        var time = new Array(sampleCount);
        var columns = {};
        for (i = 0; i < wanted.length; i++) columns[wanted[i]] = new Array(sampleCount);

        var n = 0;
        for (c = 0; c < chunks.length; c++) {
            var frames = chunks[c].frames;
            for (var f = 0; f < frames.length; f++) {
                var frame = frames[f];
                time[n] = frame[timeFieldIndex] / 1000000; // microseconds -> seconds
                for (i = 0; i < wanted.length; i++) {
                    columns[wanted[i]][n] = frame[fieldIndexByName[wanted[i]]];
                }
                n++;
            }
        }

        return { time: time, columns: columns, sampleCount: sampleCount };
    }

    // ------------------------------------------------------------------
    // Stable-flight-phase detection — a simplified port of Blackbox_Lab's
    // flightPhase.js. Finds steady cruise/level stretches (and, where a
    // speed-governed motor is fitted, steady-governed stretches) so the
    // labs below aren't scored on spool-up/down or target-change transients.
    // ------------------------------------------------------------------

    function movingAverage(values, windowSamples) {
        var n = values.length;
        var result = new Array(n);
        var sum = 0;
        var half = Math.max(1, Math.floor(windowSamples / 2));

        for (var i = 0; i < n; i++) {
            var lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
            // Recompute the window sum directly -- simplest correct approach;
            // this only runs once per log load, not per frame render.
            sum = 0;
            for (var k = lo; k <= hi; k++) sum += values[k];
            result[i] = sum / (hi - lo + 1);
        }
        return result;
    }

    function percentile(sortedValues, fraction) {
        var idx = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(fraction * (sortedValues.length - 1))));
        return sortedValues[idx];
    }

    // `flying` (optional, per sample) limits the search to real flight: see
    // buildModeMasks. Samples outside it are never stable, and the calm floor
    // below is taken from flying samples only -- otherwise on an aerobatic
    // flight the calmest 10 % is time on the ground and "stable" means parked.
    function detectStableFlightPhase(time, motorSpeed, governorTarget, gyroActivity, flying) {
        var n = time.length;

        if (n < 50 || time[n - 1] - time[0] <= 0) {
            return { stableIndexes: [], stableSampleCount: 0, reason: "This flight is too short to analyze." };
        }

        var hasMotorSpeed = false;
        if (motorSpeed) {
            for (var h = 0; h < n; h++) if (motorSpeed[h] > 500) { hasMotorSpeed = true; break; }
        }
        var hasGovernorTarget = false;
        if (governorTarget) {
            for (var g = 0; g < n; g++) if (governorTarget[g] > 500) { hasGovernorTarget = true; break; }
        }

        var sampleRateHz = n / (time[n - 1] - time[0]);
        var windowSamples = Math.max(1, Math.round(sampleRateHz * 2)); // +-2s

        var candidate = new Array(n);
        var i, lo, hi;
        var basis;

        if (hasMotorSpeed && hasGovernorTarget) {
            // Best case: an actively governed motor gives a direct, precise
            // read on "steady" -- target barely moving, actual speed
            // tracking it closely.
            basis = "motor-speed";

            for (i = 0; i < n; i++) {
                var speed = motorSpeed[i];
                candidate[i] = false;
                if (speed < 500 || governorTarget[i] <= 500) continue;

                lo = Math.max(0, i - windowSamples);
                hi = Math.min(n - 1, i + windowSamples);

                var targetSpread = spread(governorTarget, lo, hi);
                var trackingError = Math.abs(governorTarget[i] - speed) / governorTarget[i];
                candidate[i] = targetSpread < 20 && trackingError <= 0.08;
            }

            // Blank out +-2s windows around governor-target steps
            for (i = 1; i < n; i++) {
                if (Math.abs(governorTarget[i] - governorTarget[i - 1]) > 20) {
                    lo = Math.max(0, i - windowSamples);
                    hi = Math.min(n - 1, i + windowSamples);
                    for (var j = lo; j <= hi; j++) candidate[j] = false;
                }
            }
        } else if (gyroActivity) {
            // The normal case: no governor target logged (current WingFlight
            // firmware doesn't log one at all -- see analyzeGovernorLab), and
            // an ungoverned prop's RPM naturally wanders with throttle/pitch
            // even during smooth, level cruise, so a plateau check on motor
            // speed itself is the wrong signal here regardless of whether
            // motor speed is logged. Airframe motion is the right one: a
            // period where the aircraft is flying level/steady (not actively
            // maneuvering) shows up as a sustained low-and-flat patch on
            // summed |gyro|, which works the same whether or not there's a
            // motor-speed sensor at all.
            basis = "gyro-activity";

            var smoothed = movingAverage(gyroActivity, Math.round(sampleRateHz));
            var sorted = (flying ? smoothed.filter(function(v, k) { return flying[k]; }) : smoothed.slice(0))
                .sort(function(a, b) { return a - b; });
            if (!sorted.length) {
                return { stableIndexes: [], stableSampleCount: 0, reason: "No powered, armed flight was found in this log." };
            }
            // Anchor on a low percentile of the *whole* flight as the calm
            // floor -- robust regardless of how much of the flight is spent
            // maneuvering (a high/low percentile split like quiet-vs-busy
            // breaks down when the busy fraction is small, since a "busy"
            // percentile then just lands back in the calm band). A generous
            // multiplicative + absolute margin absorbs normal noise in the
            // calm band without needing a separate busy reference at all.
            var calmFloor = percentile(sorted, 0.1);
            var threshold = calmFloor * 1.8 + 2;

            for (i = 0; i < n; i++) {
                candidate[i] = smoothed[i] <= threshold;
            }
        } else if (hasMotorSpeed) {
            // Last resort: no gyro data to fall back on, so use a plateau
            // check on motor speed itself. Weaker signal for an ungoverned
            // prop (see above), but better than nothing.
            basis = "motor-speed-plateau";

            for (i = 0; i < n; i++) {
                var s = motorSpeed[i];
                candidate[i] = false;
                if (s < 500) continue;

                lo = Math.max(0, i - windowSamples);
                hi = Math.min(n - 1, i + windowSamples);
                candidate[i] = spread(motorSpeed, lo, hi) < Math.max(40, s * 0.03);
            }
        } else {
            return { stableIndexes: [], stableSampleCount: 0, reason: "No motor-speed or gyro data logged, so a steady-flight window can't be identified." };
        }

        if (flying) {
            for (i = 0; i < n; i++) candidate[i] = candidate[i] && flying[i];
        }

        // Keep only contiguous runs of >=3s, trimming 3s off each end
        var trimSamples = Math.round(sampleRateHz * 3);
        var minRunSamples = Math.round(sampleRateHz * 3);
        var stableIndexes = [];
        var runStart = null;

        for (i = 0; i <= n; i++) {
            var isStable = i < n && candidate[i];
            if (isStable && runStart === null) {
                runStart = i;
            } else if (!isStable && runStart !== null) {
                var runEnd = i; // exclusive
                if (runEnd - runStart >= minRunSamples) {
                    for (var k = runStart + trimSamples; k < runEnd - trimSamples; k++) stableIndexes.push(k);
                }
                runStart = null;
            }
        }

        return {
            stableIndexes: stableIndexes,
            stableSampleCount: stableIndexes.length,
            sampleRateHz: sampleRateHz,
            basis: basis,
            reason: stableIndexes.length ? null : "No steady flight segment of 3s or more was found — try a longer or steadier flight."
        };
    }

    // ------------------------------------------------------------------
    // Motor speed / governor lab
    // ------------------------------------------------------------------

    function analyzeGovernorLab(ctx) {
        var motorSpeed = ctx.columns.motor1speed;
        var target = ctx.columns.govTarget || ctx.columns.govRequest;

        if (!motorSpeed) return insufficient("No motor-speed data was logged for this flight.");
        if (ctx.stable.stableSampleCount < MIN_STABLE_SAMPLES) return insufficient(ctx.stable.reason);

        var idx = ctx.stable.stableIndexes;
        var speedStable = pickAtIndexes(motorSpeed, idx);

        // Current WingFlight firmware runs an RPM governor (flight/governor.c)
        // but doesn't log its internal target to blackbox -- only the actual
        // motor speed reaches the log. If a target ever does show up (older or
        // future logs), prefer the more precise sag-vs-target read; otherwise
        // fall back to scoring how steady the motor held its own speed.
        if (target) return analyzeGovernorAgainstTarget(speedStable, pickAtIndexes(target, idx));

        // Without a target, speed only means something against the throttle that
        // asked for it: keep samples where the throttle stick held steady, and
        // score each against the usual speed at that throttle.
        var throttle = ctx.columns["rcCommand[4]"];
        if (!throttle) return analyzeGovernorSteadiness(speedStable);
        var steady = steadyThrottleIndexes(ctx.time, throttle, idx);
        if (steady.length < MIN_STABLE_SAMPLES) {
            return insufficient("The throttle never held steady long enough during stable flight to judge motor-speed steadiness.");
        }
        return analyzeGovernorSteadiness(pickAtIndexes(motorSpeed, steady), pickAtIndexes(throttle, steady));
    }

    var STEADY_THROTTLE_SPREAD = 20;     // rcCommand[4] units (0..1000) over +- STEADY_THROTTLE_SECONDS
    var STEADY_THROTTLE_SECONDS = 1;
    var THROTTLE_BIN = 25;               // speed is compared within throttle bands this wide

    function steadyThrottleIndexes(time, throttle, indexes) {
        var n = time.length;
        var rate = n > 1 ? n / (time[n - 1] - time[0]) : 1;
        var half = Math.max(1, Math.round(rate * STEADY_THROTTLE_SECONDS));
        var result = [];
        for (var i = 0; i < indexes.length; i++) {
            var k = indexes[i];
            if (spread(throttle, Math.max(0, k - half), Math.min(n - 1, k + half)) < STEADY_THROTTLE_SPREAD) result.push(k);
        }
        return result;
    }

    function analyzeGovernorAgainstTarget(speedStable, targetStable) {
        var avgTarget = average(targetStable);
        var avgSpeed = average(speedStable);
        var maxSag = 0;
        var errors = new Array(speedStable.length);
        for (var i = 0; i < speedStable.length; i++) {
            var sag = targetStable[i] - speedStable[i];
            if (sag > maxSag) maxSag = sag;
            errors[i] = targetStable[i] - speedStable[i];
        }
        var rmsError = rms(errors);
        var sagPercent = avgTarget ? (maxSag / avgTarget) * 100 : 0;

        var status = sagPercent > 3 ? "attention" : sagPercent > 1.2 ? "watch" : "good";

        var story;
        if (status === "good") {
            story = "Excellent stable-flight hold: average motor speed " + Math.round(avgSpeed) + " rpm against a " +
                Math.round(avgTarget) + " rpm target. Largest observed tracking dip was " + Math.round(maxSag) + " rpm.";
        } else if (status === "watch") {
            story = "Motor speed mostly held its target, but dipped as much as " + Math.round(maxSag) + " rpm (" +
                sagPercent.toFixed(1) + "%) under load during stable flight — worth keeping an eye on.";
        } else {
            story = "Motor speed dropped noticeably under load: up to " + Math.round(maxSag) + " rpm (" +
                sagPercent.toFixed(1) + "%) below target during stable flight. Consider more governor gain, or check for a power-system limit.";
        }

        return {
            status: status,
            story: story,
            metrics: [
                { label: "Average motor speed", value: Math.round(avgSpeed) + " rpm" },
                { label: "Average target", value: Math.round(avgTarget) + " rpm" },
                { label: "Max sag", value: Math.round(maxSag) + " rpm (" + sagPercent.toFixed(1) + "%)" },
                { label: "RMS tracking error", value: Math.round(rmsError) + " rpm" }
            ],
            sagPercent: sagPercent
        };
    }

    // No governor-target telemetry available (the normal case on current
    // firmware) -- score on how steady the motor held its own speed during
    // stable flight instead of sag-vs-target.
    // `throttleSteady` (optional): the throttle for each sample. When given,
    // each sample is compared with the average speed in its throttle band, and
    // the largest deviation is the 95th percentile rather than a single spike.
    function analyzeGovernorSteadiness(speedStable, throttleSteady) {
        var avgSpeed = average(speedStable);
        var reference = new Array(speedStable.length);
        var i;
        if (throttleSteady) {
            var bandSum = {}, bandCount = {};
            for (i = 0; i < speedStable.length; i++) {
                var band = Math.round(throttleSteady[i] / THROTTLE_BIN);
                bandSum[band] = (bandSum[band] || 0) + speedStable[i];
                bandCount[band] = (bandCount[band] || 0) + 1;
            }
            for (i = 0; i < speedStable.length; i++) {
                var b = Math.round(throttleSteady[i] / THROTTLE_BIN);
                reference[i] = bandSum[b] / bandCount[b];
            }
        } else {
            for (i = 0; i < speedStable.length; i++) reference[i] = avgSpeed;
        }

        var deviations = new Array(speedStable.length);
        var relative = new Array(speedStable.length);
        for (i = 0; i < speedStable.length; i++) {
            deviations[i] = speedStable[i] - reference[i];
            relative[i] = reference[i] ? Math.abs(deviations[i]) / reference[i] : 0;
        }
        var rmsDeviation = rms(deviations);
        var sortedRelative = relative.slice(0).sort(function(a, c) { return a - c; });
        var variabilityPercent = (throttleSteady ? percentile(sortedRelative, 0.95) : maxOf(relative)) * 100;
        var maxDeviation = variabilityPercent / 100 * avgSpeed;

        var status = variabilityPercent > 3 ? "attention" : variabilityPercent > 1.2 ? "watch" : "good";

        var caveat = throttleSteady
            ? " (No governor target is logged, so this compares speed only at a steady throttle, against the usual speed at that throttle.)"
            : " (This firmware doesn't log a governor target, so this reflects motor-speed steadiness, not tracking accuracy.)";
        var story;
        if (status === "good") {
            story = "Motor speed held steady during stable flight: averaged " + Math.round(avgSpeed) +
                " rpm, straying by at most " + Math.round(maxDeviation) + " rpm (" + variabilityPercent.toFixed(1) + "%)." + caveat;
        } else if (status === "watch") {
            story = "Motor speed mostly held steady, but wandered as much as " + Math.round(maxDeviation) + " rpm (" +
                variabilityPercent.toFixed(1) + "%) during stable flight — worth keeping an eye on." + caveat;
        } else {
            story = "Motor speed varied noticeably during stable flight: up to " + Math.round(maxDeviation) + " rpm (" +
                variabilityPercent.toFixed(1) + "%) away from its " + (throttleSteady ? "usual speed at that throttle" : "average") +
                ". Consider more governor gain, or check for a power-system limit." + caveat;
        }

        return {
            status: status,
            story: story,
            metrics: [
                { label: "Average motor speed", value: Math.round(avgSpeed) + " rpm" },
                { label: "Max deviation", value: Math.round(maxDeviation) + " rpm (" + variabilityPercent.toFixed(1) + "%)" },
                { label: "RMS variation", value: Math.round(rmsDeviation) + " rpm" }
            ],
            variabilityPercent: variabilityPercent
        };
    }

    // ------------------------------------------------------------------
    // Idle chop recovery lab
    // ------------------------------------------------------------------

    function analyzeIdleChopRecoveryLab(ctx) {
        var throttle = ctx.columns["rcCommand[4]"];
        var motorSpeed = ctx.columns.motor1speed;
        var motorOutput = ctx.columns["motor[0]"];

        if (!throttle) return insufficient("No throttle-command data was logged for this flight.");
        if (!motorSpeed) return insufficient("No motor-speed data was logged for this flight.");
        if (!motorOutput) return insufficient("No motor output data was logged for this flight.");

        var IDLE_THROTTLE = 20;      // blackbox rcCommand[4] is 0..1000
        var PULSE_THROTTLE = 200;    // require a real pulse, not stick noise
        var PRE_IDLE_SECONDS = 0.75;
        var RECOVERY_SECONDS = 1.50;
        var MIN_IDLE_SECONDS = 0.35;
        var MIN_IDLE_SAMPLES = 20;

        var pulses = findIdleChopPulses(ctx.time, throttle, motorSpeed, motorOutput,
            IDLE_THROTTLE, PULSE_THROTTLE, PRE_IDLE_SECONDS, RECOVERY_SECONDS, MIN_IDLE_SECONDS, MIN_IDLE_SAMPLES);

        if (!pulses.length) {
            return insufficient("No clean idle-chop sequence was found. This check needs throttle pulses that start from idle, return to idle, and leave at least a short idle recovery window.");
        }

        var baselineRpm = average(pulses.map(function(p) { return p.baselineRpm; }));
        var baselineOutput = median(pulses.map(function(p) { return p.baselineOutput; }));
        var minRpm = minOf(pulses.map(function(p) { return p.minRpm; }));
        var minOutput = minOf(pulses.map(function(p) { return p.minOutput; }));
        var maxDipPercent = maxOf(pulses.map(function(p) { return p.dipPercent; }));
        var maxRecoveryTime = maxOf(pulses.map(function(p) { return p.recoveryTime === null ? RECOVERY_SECONDS : p.recoveryTime; }));

        var outputDropPercent = baselineOutput > 0 ? ((baselineOutput - minOutput) / baselineOutput) * 100 : 0;
        var outputFloorTooLow = baselineOutput > 0 && minOutput < baselineOutput * 0.85;
        var status = "good";
        if (maxDipPercent > 25 || maxRecoveryTime > 1.0 || outputDropPercent > 20) status = "attention";
        else if (maxDipPercent > 12 || maxRecoveryTime > 0.6 || outputDropPercent > 10) status = "watch";

        var story;
        if (status === "good") {
            story = "Idle chop recovery looked clean across " + pulses.length + " pulse" + (pulses.length === 1 ? "" : "s") +
                ": motor speed stayed close to the settled idle and recovered promptly.";
        } else if (outputFloorTooLow) {
            story = "Idle chop recovery sagged after throttle cuts: settled idle held around " + formatMotorOutputPercent(baselineOutput) +
                " output, but post-chop output fell as low as " + formatMotorOutputPercent(minOutput) +
                ". Raise governor_throttle toward the settled idle output and keep governor_handover above that floor.";
        } else {
            story = "Idle chop recovery dipped after throttle cuts: motor speed fell as much as " +
                maxDipPercent.toFixed(0) + "% below the settled idle before recovering. Consider slightly more governor gain if the idle floor already matches the settled output.";
        }

        return {
            status: status,
            story: story,
            metrics: [
                { label: "Pulses analyzed", value: String(pulses.length) },
                { label: "Settled idle speed", value: Math.round(baselineRpm) + " rpm" },
                { label: "Deepest speed dip", value: Math.round(minRpm) + " rpm (" + maxDipPercent.toFixed(0) + "%)" },
                { label: "Settled idle output", value: formatMotorOutputPercent(baselineOutput) },
                { label: "Lowest post-chop output", value: formatMotorOutputPercent(minOutput) },
                { label: "Slowest recovery", value: maxRecoveryTime.toFixed(2) + "s" }
            ],
            dipPercent: maxDipPercent,
            outputDropPercent: outputDropPercent
        };
    }

    function findIdleChopPulses(time, throttle, motorSpeed, motorOutput,
        idleThrottle, pulseThrottle, preIdleSeconds, recoverySeconds, minIdleSeconds, minIdleSamples) {
        var pulses = [];
        var n = time.length;
        var i = 0;

        while (i < n) {
            while (i < n && throttle[i] <= pulseThrottle) i++;
            if (i >= n) break;

            var highStart = i;
            while (i < n && throttle[i] > pulseThrottle) i++;
            var highEnd = i - 1;

            var pulseStart = highStart;
            while (pulseStart > 0 && throttle[pulseStart - 1] > idleThrottle) pulseStart--;

            var chopIndex = i;
            while (chopIndex < n && throttle[chopIndex] > idleThrottle) chopIndex++;
            if (chopIndex >= n) break;

            var nextPulseIndex = chopIndex + 1;
            while (nextPulseIndex < n && throttle[nextPulseIndex] <= idleThrottle) nextPulseIndex++;

            var idleEndTime = Math.min(time[chopIndex] + recoverySeconds,
                nextPulseIndex < n ? time[nextPulseIndex] : time[n - 1]);
            var idleDuration = idleEndTime - time[chopIndex];

            var beforeIndexes = indexesInWindow(time, throttle, pulseStart, time[pulseStart] - preIdleSeconds,
                time[pulseStart], idleThrottle, motorSpeed);
            var afterIndexes = indexesInWindow(time, throttle, chopIndex, time[chopIndex],
                idleEndTime, idleThrottle, motorSpeed);

            if (idleDuration >= minIdleSeconds &&
                    beforeIndexes.length >= minIdleSamples &&
                    afterIndexes.length >= minIdleSamples &&
                    time[highEnd] > time[highStart]) {
                var pulse = summarizeIdleChopPulse(time, motorSpeed, motorOutput, beforeIndexes, afterIndexes);
                if (pulse) pulses.push(pulse);
            }

            i = Math.max(chopIndex + 1, highEnd + 1);
        }

        return pulses;
    }

    function indexesInWindow(time, throttle, startSearch, startTime, endTime, idleThrottle, motorSpeed) {
        var result = [];
        var first = startSearch;
        while (first > 0 && time[first] >= startTime) first--;

        for (var i = first; i < time.length && time[i] <= endTime; i++) {
            if (time[i] >= startTime && throttle[i] <= idleThrottle && motorSpeed[i] > 500) {
                result.push(i);
            }
        }
        return result;
    }

    function summarizeIdleChopPulse(time, motorSpeed, motorOutput, beforeIndexes, afterIndexes) {
        var beforeRpm = pickAtIndexes(motorSpeed, beforeIndexes);
        var beforeOutput = pickAtIndexes(motorOutput, beforeIndexes);
        var afterRpm = pickAtIndexes(motorSpeed, afterIndexes);
        var afterOutput = pickAtIndexes(motorOutput, afterIndexes);

        var baselineRpm = median(beforeRpm);
        var baselineOutput = median(beforeOutput);
        var minRpm = minOf(afterRpm);
        var minOutput = minOf(afterOutput);
        if (!baselineRpm || baselineRpm <= 0) return null;

        var beforeRpmSpread = maxOf(beforeRpm) - minOf(beforeRpm);
        var beforeOutputSpread = maxOf(beforeOutput) - minOf(beforeOutput);
        if (beforeRpmSpread > Math.max(200, baselineRpm * 0.25) ||
                beforeOutputSpread > Math.max(30, baselineOutput * 0.25)) {
            return null;
        }

        var minRpmIndex = afterIndexes[0];
        for (var i = 0; i < afterIndexes.length; i++) {
            if (motorSpeed[afterIndexes[i]] === minRpm) {
                minRpmIndex = afterIndexes[i];
                break;
            }
        }

        var recoveredAt = null;
        var recoveryThreshold = baselineRpm * 0.95;
        for (i = 0; i < afterIndexes.length; i++) {
            var idx = afterIndexes[i];
            if (idx >= minRpmIndex && motorSpeed[idx] >= recoveryThreshold) {
                recoveredAt = time[idx] - time[afterIndexes[0]];
                break;
            }
        }

        return {
            baselineRpm: baselineRpm,
            baselineOutput: baselineOutput,
            minRpm: minRpm,
            minOutput: minOutput,
            dipPercent: ((baselineRpm - minRpm) / baselineRpm) * 100,
            recoveryTime: recoveredAt
        };
    }

    function formatMotorOutputPercent(value) {
        return (value / 10).toFixed(1) + "%";
    }

    // ------------------------------------------------------------------
    // Power / ESC lab
    // ------------------------------------------------------------------

    function analyzeEscLab(ctx) {
        var throttlePct, throttleSource;

        if (ctx.columns.EscThr) {
            throttlePct = ctx.columns.EscThr.map(function(v) { return v / 10; });
            throttleSource = "ESC-reported throttle";
        } else if (ctx.columns["motor[0]"]) {
            throttlePct = ctx.columns["motor[0]"].map(function(v) { return v / 10; });
            throttleSource = "motor output (no ESC telemetry logged)";
        } else {
            return insufficient("No ESC or motor output data was logged for this flight.");
        }

        if (ctx.stable.stableSampleCount < MIN_STABLE_SAMPLES) return insufficient(ctx.stable.reason);

        var idx = ctx.stable.stableIndexes;
        var throttleStable = pickAtIndexes(throttlePct, idx);
        var avgThrottle = average(throttleStable);
        var headroom = 100 - avgThrottle;

        var saturated = 0;
        for (var i = 0; i < throttleStable.length; i++) if (throttleStable[i] >= 97) saturated++;
        var saturationPercent = (saturated / throttleStable.length) * 100;

        var status = saturationPercent > 2 ? "attention" : headroom < 12 ? "watch" : "good";

        var metrics = [
            { label: "Average throttle", value: avgThrottle.toFixed(1) + "% (" + throttleSource + ")" },
            { label: "Headroom", value: headroom.toFixed(1) + "%" },
            { label: "Time at/near full output", value: saturationPercent.toFixed(1) + "%" }
        ];

        var current = ctx.columns.EscI || ctx.columns.Ibat;
        if (current) {
            var currentStable = pickAtIndexes(current, idx).map(function(v) { return v / 100; });
            metrics.push({ label: "Average current", value: average(currentStable).toFixed(1) + " A (est.)" });
            metrics.push({ label: "Peak current", value: maxOf(currentStable).toFixed(1) + " A (est.)" });
        }

        var story;
        if (status === "good") {
            story = "Throttle (" + throttleSource + ") averaged " + avgThrottle.toFixed(0) +
                "% during stable flight, leaving healthy headroom.";
        } else if (status === "watch") {
            story = "Throttle averaged " + avgThrottle.toFixed(0) + "% during stable flight — headroom is getting thin (" +
                headroom.toFixed(0) + "%).";
        } else {
            story = "Throttle sat at or above 97% for " + saturationPercent.toFixed(1) +
                "% of stable flight. The governor had little remaining output authority during those periods.";
        }

        return { status: status, story: story, metrics: metrics, saturationPercent: saturationPercent };
    }

    // ------------------------------------------------------------------
    // Battery lab
    // ------------------------------------------------------------------

    function analyzeBatteryLab(ctx, flightLog) {
        var voltageRaw = ctx.columns.Vbat || ctx.columns.EscV;
        if (!voltageRaw) return insufficient("No battery/ESC voltage data was logged for this flight.");
        if (ctx.stable.stableSampleCount < MIN_STABLE_SAMPLES) return insufficient(ctx.stable.reason);

        var voltage = voltageRaw.map(function(v) { return v / 100; });
        var idx = ctx.stable.stableIndexes;
        var stableVoltage = pickAtIndexes(voltage, idx);

        var cellCount = flightLog.getNumCellsEstimate();
        if (!cellCount) cellCount = Math.max(1, Math.round(voltage[0] / 4.1));

        var minV = Math.min.apply(null, stableVoltage);
        var startV = voltage[0];
        var minVPerCell = minV / cellCount;
        var sagPercent = startV ? ((startV - minV) / startV) * 100 : 0;

        var status = minVPerCell < 3.45 ? "attention" : minVPerCell < 3.6 ? "watch" : "good";

        var story;
        if (status === "good") {
            story = "Pack held up well: lowest stable-flight voltage was " + minV.toFixed(2) + "V (" +
                minVPerCell.toFixed(2) + "V/cell).";
        } else if (status === "watch") {
            story = "The lowest stable-flight voltage was " + minV.toFixed(2) + "V (" + minVPerCell.toFixed(2) +
                "V/cell). Worth watching on future flights — one dip alone doesn't prove the pack is tired.";
        } else {
            story = "Voltage sagged to " + minV.toFixed(2) + "V (" + minVPerCell.toFixed(2) +
                "V/cell) during stable flight — check the matching current draw, and consider the pack's health.";
        }

        return {
            status: status,
            story: story,
            metrics: [
                { label: "Cell count (est.)", value: cellCount + "S" },
                { label: "Start voltage", value: startV.toFixed(2) + "V" },
                { label: "Min voltage (stable)", value: minV.toFixed(2) + "V (" + minVPerCell.toFixed(2) + "V/cell)" },
                { label: "Sag", value: sagPercent.toFixed(1) + "%" }
            ]
        };
    }

    // ------------------------------------------------------------------
    // Vibration lab — reuses the app's own FFT (GraphSpectrumCalc /
    // js/complex.js) restricted to the stable-flight window, so the numbers
    // agree with what the Analyser panel would show for the same time range.
    // ------------------------------------------------------------------

    var GYRO_FIELDS = ["gyroADC[0]", "gyroADC[1]", "gyroADC[2]"];
    var AXIS_NAMES = ["Roll", "Pitch", "Yaw"];

    function classifyVibrationSource(peakHz, motorSpeedRpm) {
        if (!motorSpeedRpm) return "not clearly linked to motor speed (no motor-speed data to compare against)";
        var revHz = motorSpeedRpm / 60;
        var ratio = peakHz / revHz;
        function near(target) { return Math.abs(ratio - target) <= target * 0.12 + 0.15; }
        if (near(1)) return "1x motor/prop speed (balance)";
        if (near(2)) return "2x motor/prop speed (e.g. 2-blade prop pass)";
        if (near(3)) return "3x motor/prop speed";
        if (ratio > 3 && ratio <= 6.5) return "a higher harmonic of motor speed";
        if (ratio > 6.5) return "high frequency — likely motor/bearing noise";
        return "not clearly linked to motor speed (electrical or airframe resonance)";
    }

    function findSpectrumPeak(fftData) {
        if (!fftData || !fftData.fftOutput || !fftData.fftLength) return null;

        // Same bin -> Hz convention the app's own Analyser plot uses (see
        // graph_spectrum_calc.js's _normalizeFft / graph_spectrum_plot.js),
        // so these numbers agree with what's shown there for the same window.
        var maxFrequency = fftData.blackBoxRate / 2;
        var hzPerBin = maxFrequency / fftData.fftLength;
        var minBin = Math.max(1, Math.round(20 / hzPerBin)); // skip DC / very-low-frequency

        var bestBin = -1, bestMag = -Infinity;
        for (var i = minBin; i < fftData.fftOutput.length && i < fftData.fftLength; i++) {
            if (fftData.fftOutput[i] > bestMag) { bestMag = fftData.fftOutput[i]; bestBin = i; }
        }
        if (bestBin < 0) return null;

        return { hz: bestBin * hzPerBin, magnitude: bestMag };
    }

    function analyzeVibrationLab(ctx, flightLog) {
        var haveGyro = false;
        for (var g = 0; g < GYRO_FIELDS.length; g++) if (ctx.columns[GYRO_FIELDS[g]]) haveGyro = true;
        if (!haveGyro) return insufficient("No gyro data was logged for this flight.");
        if (ctx.stable.stableSampleCount < MIN_STABLE_SAMPLES) return insufficient(ctx.stable.reason);

        var idx = ctx.stable.stableIndexes;
        var stableStartUs = ctx.time[idx[0]] * 1000000;
        var stableEndUs = ctx.time[idx[idx.length - 1]] * 1000000;

        var motorSpeedAtWindow = ctx.columns.motor1speed ? average(pickAtIndexes(ctx.columns.motor1speed, idx)) : null;

        var identityCurve = { lookupRaw: function(v) { return v; } };

        GraphSpectrumCalc.initialize(flightLog, flightLog.getSysConfig());
        GraphSpectrumCalc.setInTime(stableStartUs);
        GraphSpectrumCalc.setOutTime(stableEndUs);

        var results = [];
        var worstMagnitude = -Infinity, worstAxis = null, worstHz = null;

        for (var axis = 0; axis < 3; axis++) {
            var fieldName = GYRO_FIELDS[axis];
            var fieldIndex = flightLog.getMainFieldIndexByName(fieldName);
            if (fieldIndex === undefined) continue;

            GraphSpectrumCalc.setDataBuffer({ fieldIndex: fieldIndex, curve: identityCurve, fieldName: fieldName });

            var fftData;
            try {
                fftData = GraphSpectrumCalc.dataLoadFrequency();
            } catch (e) {
                continue;
            }

            var peak = findSpectrumPeak(fftData);
            if (!peak) continue;

            results.push({ axis: AXIS_NAMES[axis], hz: peak.hz, source: classifyVibrationSource(peak.hz, motorSpeedAtWindow) });
            if (peak.magnitude > worstMagnitude) {
                worstMagnitude = peak.magnitude;
                worstAxis = AXIS_NAMES[axis];
                worstHz = peak.hz;
            }
        }

        if (!results.length) return insufficient("Could not compute a vibration spectrum for this flight.");

        // No good/watch/attention verdict here, and no numeric filter cutoff
        // recommendation — only the strongest peak per axis and what it's
        // likely linked to. See the plan's scope notes for why.
        var story = "Strongest vibration is on " + worstAxis + " at " + worstHz.toFixed(1) + " Hz — " +
            classifyVibrationSource(worstHz, motorSpeedAtWindow) +
            ". Open the Analyser (top toolbar) around this part of the flight to look closer.";

        return {
            status: "info",
            story: story,
            metrics: results.map(function(r) { return { label: r.axis + " peak", value: r.hz.toFixed(1) + " Hz — " + r.source }; })
        };
    }

    // ------------------------------------------------------------------
    // Thrust Vector lab — informational only (no good/watch/attention
    // thresholds yet: this is a brand-new firmware feature with no flight
    // data to calibrate against). Reports how hard the independent TV PID
    // loop is working and whether its I-term is carrying a steady bias,
    // which is worth a look regardless of any threshold.
    // ------------------------------------------------------------------

    var TV_TERMS = ["P", "I", "D", "F", "B"];

    function analyzeThrustVectorLab(ctx) {
        var haveTv = false;
        for (var a = 0; a < 3; a++) if (ctx.columns["tvAxisP[" + a + "]"]) haveTv = true;
        if (!haveTv) return insufficient("No Thrust Vector data was logged for this flight (feature not enabled, or this firmware doesn't log it yet).");
        if (ctx.stable.stableSampleCount < MIN_STABLE_SAMPLES) return insufficient(ctx.stable.reason);

        var idx = ctx.stable.stableIndexes;
        var axisResults = [];
        var worstOutput = -1, worstAxis = null;

        for (var axis = 0; axis < 3; axis++) {
            var termField = {};
            var haveAxis = true;
            for (var t = 0; t < TV_TERMS.length; t++) {
                var field = ctx.columns["tvAxis" + TV_TERMS[t] + "[" + axis + "]"];
                if (!field) { haveAxis = false; break; }
                termField[TV_TERMS[t]] = field;
            }
            if (!haveAxis) continue;

            var outputSum = new Array(idx.length);
            var iTermStable = new Array(idx.length);
            for (var i = 0; i < idx.length; i++) {
                var sample = idx[i];
                outputSum[i] = termField.P[sample] + termField.I[sample] + termField.D[sample] + termField.F[sample] + termField.B[sample];
                iTermStable[i] = termField.I[sample];
            }

            var rmsOutput = rms(outputSum);
            var avgITerm = average(iTermStable);

            if (rmsOutput > worstOutput) {
                worstOutput = rmsOutput;
                worstAxis = AXIS_NAMES[axis];
            }

            axisResults.push({ axis: AXIS_NAMES[axis], rmsOutput: rmsOutput, avgITerm: avgITerm });
        }

        if (!axisResults.length) return insufficient("Thrust Vector fields were present but incomplete for every axis.");

        var story = "Thrust Vector loop was active during stable flight — " + worstAxis + " carried the most output (" +
            rmsOutputPercent(worstOutput) + "% RMS). A large steady I-term while holding level flight can mean the loop " +
            "is fighting a trim offset rather than a maneuver — check the per-axis I-term figures below if any look large and one-sided.";

        return {
            status: "info",
            story: story,
            metrics: axisResults.map(function(r) {
                return {
                    label: r.axis + " (TV)",
                    value: rmsOutputPercent(r.rmsOutput) + "% RMS output, " + rmsOutputPercent(r.avgITerm) + "% avg I-term"
                };
            })
        };
    }

    // PID terms are logged in the same fixed-point scale as the main loop
    // (raw * 1000, decoded elsewhere as raw/10 = percent) -- see
    // FlightLog.prototype.getPIDPercentage and blackbox.c's tvAxisPID_* encode.
    function rmsOutputPercent(rawValue) {
        return (rawValue / 10).toFixed(1);
    }

    // ------------------------------------------------------------------
    // PID tracking lab (lightweight — see plan's scope notes: this is a
    // simplified RMS-tracking-error + PID-sum-saturation check, not a full
    // step-response/overshoot/ringing analysis).
    // ------------------------------------------------------------------

    // PID tracking is graded on the step response (js/graph_stepresponse_calc.js)
    // over the analysed range: how far each axis settles from the commanded rate,
    // using only windows that measure the rate loop (see that file). Calm-flight
    // error ratios were tried first and divided gust error by stick inputs of a
    // few deg/s, reporting 100 %+ errors on a well-tuned model.
    var TRACKING_GOOD = 0.2;    // |settled - 1| up to this is good
    var TRACKING_WATCH = 0.35;  // up to this is worth watching, beyond is attention
    var F_GAIN_MIN = 50;        // Wingflight's minimum F (PID_F_GAIN_MIN)
    var TRACKING_MIN_WINDOWS = 30;              // fewer step-response windows than this aren't graded
    var TRACKING_PLAUSIBLE = [0.3, 3];          // a settled value outside this isn't a tracking result
    var F_ADVICE_RANGE = [0.5, 2];              // only suggest an F change inside this

    function analyzePidLab(ctx, flightLog) {
        var sysConfig = flightLog.getSysConfig();
        var step = ctx.stepResponse;
        if (!step) return insufficient("No setpoint/gyro tracking data was logged for this flight.");

        var idx = ctx.stable.stableIndexes;
        var pidSumLimit = { 0: sysConfig.pidSumLimit, 1: sysConfig.pidSumLimit, 2: sysConfig.pidSumLimitYaw };
        var pidFields = ["rollPID", "pitchPID", "yawPID"];

        var axisResults = [];
        var worstDeviation = -1, worstAxis = null, worstSettled = null, worstF = null;
        var worstSaturationPercent = 0, saturatedAxis = null;
        var ungraded = [];

        for (var axis = 0; axis < 3; axis++) {
            var axisStep = step[["roll", "pitch", "yaw"][axis]];
            var settled = null;
            if (axisStep && axisStep.windowCount > 0) {
                var rate = 1 / (axisStep.time[1] - axisStep.time[0]);
                settled = average(Array.prototype.slice.call(axisStep.response, Math.round(0.3 * rate)));
            }
            var graded = axisStep && axisStep.valid && settled !== null &&
                axisStep.windowCount >= TRACKING_MIN_WINDOWS &&
                settled >= TRACKING_PLAUSIBLE[0] && settled <= TRACKING_PLAUSIBLE[1];
            if (!graded) {
                ungraded.push(AXIS_NAMES[axis]);
            } else if (Math.abs(settled - 1) > worstDeviation) {
                worstDeviation = Math.abs(settled - 1);
                worstAxis = AXIS_NAMES[axis];
                worstSettled = settled;
                var pid = sysConfig[pidFields[axis]];
                worstF = pid && pid[3] ? pid[3] : null;
            }

            var saturationPercent = null;
            var sumField = ctx.columns["axisSum[" + axis + "]"];
            var limit = pidSumLimit[axis];
            if (sumField && limit && idx.length) {
                var sumStable = pickAtIndexes(sumField, idx);
                var saturated = 0;
                for (var s = 0; s < sumStable.length; s++) if (Math.abs(sumStable[s]) >= limit * 0.98) saturated++;
                saturationPercent = (saturated / sumStable.length) * 100;
                if (saturationPercent > worstSaturationPercent) {
                    worstSaturationPercent = saturationPercent;
                    saturatedAxis = AXIS_NAMES[axis];
                }
            }

            axisResults.push({
                axis: AXIS_NAMES[axis],
                settled: settled,
                valid: !!graded,
                windows: axisStep ? axisStep.windowCount : 0,
                coherence: axisStep ? axisStep.coherence : null,
                saturationPercent: saturationPercent
            });
        }

        if (!worstAxis && !saturatedAxis) {
            return insufficient("Not enough clean stick inputs to judge rate tracking" +
                (ungraded.length ? " (" + ungraded.join(", ") + ": too few windows, or the gyro mostly didn't follow the stick)" : "") + ".");
        }

        var status = "good";
        if (worstDeviation > TRACKING_WATCH || worstSaturationPercent > 5) status = "attention";
        else if (worstDeviation > TRACKING_GOOD || worstSaturationPercent > 1) status = "watch";

        var storyParts = [];
        var action = null;
        if (worstAxis) {
            var percentOfStick = Math.round(worstSettled * 100);
            if (worstDeviation <= TRACKING_GOOD) {
                storyParts.push("Rate tracking is close on every graded axis; " + worstAxis + " is furthest off, settling at " +
                    percentOfStick + "% of the commanded rate.");
            } else {
                storyParts.push(worstAxis + " settles at " + percentOfStick + "% of the commanded rate after a stick input" +
                    (worstSettled < 1 ? ", so the model falls short of the stick." : ", so the model runs ahead of the stick."));
                if (worstF && worstSettled >= F_ADVICE_RANGE[0] && worstSettled <= F_ADVICE_RANGE[1]) {
                    var suggestedF = Math.max(F_GAIN_MIN, Math.round(worstF / worstSettled / 5) * 5);
                    action = (worstSettled < 1 ? "Raise " : "Lower ") + worstAxis + " F from " + worstF + " towards about " + suggestedF +
                        ", then check the Step Response again." +
                        (worstSettled > 1 && suggestedF === F_GAIN_MIN ? " F can't go below " + F_GAIN_MIN + "; lower the rate instead if it's still ahead." : "");
                    storyParts.push("F sets most of the surface throw for a commanded rate.");
                }
            }
        }
        if (ungraded.length) {
            storyParts.push(ungraded.join(" and ") + " not graded: too few clean stick inputs, or the gyro mostly didn't follow the stick.");
        }
        if (saturatedAxis && worstSaturationPercent > 1) {
            storyParts.push(saturatedAxis + "'s PID sum sat near its configured limit for " +
                worstSaturationPercent.toFixed(1) + "% of stable flight — the controller had little headroom left there.");
        }

        return {
            status: status,
            story: storyParts.join(" "),
            action: action,
            metrics: axisResults.map(function(r) {
                return {
                    label: r.axis + " tracking",
                    value: (r.settled !== null && r.valid
                        ? "settles at " + Math.round(r.settled * 100) + "% (" + r.windows + " windows, coherence " + r.coherence.toFixed(2) + ")"
                        : "not graded") +
                        (r.saturationPercent !== null ? ", " + r.saturationPercent.toFixed(1) + "% saturated" : "")
                };
            })
        };
    }

    // ------------------------------------------------------------------
    // Bounce-back lab -- how far the model swings back past level when the
    // stick returns to centre after a roll or loop. Same release detection as
    // the Wingflight blackbox skill's bbtune.py.
    // ------------------------------------------------------------------

    var BOUNCE_CENTRE = 5;            // deg/s: stick setpoint counted as centred
    var BOUNCE_MIN_RATE = 60;         // deg/s: stick and gyro peak before release
    var BOUNCE_LOOKBACK_S = 0.4;      // look for the peak this far before release
    var BOUNCE_MIN_QUIET_S = 0.15;    // stick must stay centred at least this long
    var BOUNCE_MAX_QUIET_S = 0.8;     // and the rebound is searched this far
    var BOUNCE_MIN_RELEASES = 5;
    var BOUNCE_WATCH = 0.15;          // median rebound above this is worth watching
    var BOUNCE_ATTENTION = 0.30;

    function findReleases(ctx, axis) {
        var sp = ctx.columns["setpoint[" + axis + "]"], g = ctx.columns["gyroADC[" + axis + "]"];
        if (!sp || !g) return [];
        var n = sp.length, rate = ctx.sampleRateHz;
        var look = Math.round(BOUNCE_LOOKBACK_S * rate), minQuiet = Math.round(BOUNCE_MIN_QUIET_S * rate);
        var maxQuiet = Math.round(BOUNCE_MAX_QUIET_S * rate);
        var usable = ctx.rateLoopSamples;
        var rebounds = [];
        for (var i = look; i < n - maxQuiet; i++) {
            if (!(Math.abs(sp[i]) < BOUNCE_CENTRE && Math.abs(sp[i - 1]) >= BOUNCE_CENTRE)) continue;
            var spPeak = 0;
            for (var j = i - look; j < i; j++) if (Math.abs(sp[j]) > Math.abs(spPeak)) spPeak = sp[j];
            if (Math.abs(spPeak) < BOUNCE_MIN_RATE) continue;
            var dir = spPeak > 0 ? 1 : -1;
            var gPeak = 0;
            for (j = i - look; j < i + Math.round(0.1 * rate); j++) gPeak = Math.max(gPeak, dir * g[j]);
            if (gPeak < BOUNCE_MIN_RATE) continue;
            var quiet = 0;
            while (quiet < maxQuiet && Math.abs(sp[i + quiet]) < BOUNCE_CENTRE) quiet++;
            if (quiet < minQuiet) continue;
            var ok = true;
            for (j = i - look; j < i + quiet && ok; j++) ok = usable[j];
            if (!ok) continue;
            var back = 0;
            for (j = i; j < i + quiet; j++) back = Math.max(back, -dir * g[j]);
            rebounds.push(back / gPeak);
            i += quiet;
        }
        return rebounds;
    }

    function analyzeBounceLab(ctx) {
        if (!ctx.rateLoopSamples) return insufficient("No flight-mode data was logged, so stick releases can't be told apart from GYRO OFF or leveling flight.");
        var results = [];
        for (var axis = 0; axis < 3; axis++) {
            var rebounds = findReleases(ctx, axis);
            if (rebounds.length < BOUNCE_MIN_RELEASES) continue;
            var sorted = rebounds.slice(0).sort(function(a, b) { return a - b; });
            results.push({ axis: AXIS_NAMES[axis], count: rebounds.length, median: median(rebounds), p75: percentile(sorted, 0.75) });
        }
        if (!results.length) {
            return insufficient("Not enough clean stick releases (a roll or loop stopped by centring the stick) to judge bounce-back.");
        }

        var worst = results.reduce(function(a, b) { return b.median > a.median ? b : a; });
        var status = worst.median > BOUNCE_ATTENTION ? "attention" : worst.median > BOUNCE_WATCH ? "watch" : "good";
        var pct = Math.round(worst.median * 100);
        var story = status === "good"
            ? "Rolls and loops stop cleanly: when the stick is centred the model swings back at most " + pct + "% of its rate (" + worst.axis + ")."
            : worst.axis + " bounces back when the stick is centred: typically " + pct + "% of the rate it was turning at swings the other way.";

        // B (feedforward boost) kicks the surface against the rotation as the stick
        // returns, which is the most direct cure; with it at 0 that comes first.
        var pid = ctx.sysConfig[worst.axis.toLowerCase() + "PID"];
        var B = pid && pid[4] != null ? pid[4] : null;
        var action = null;
        if (status !== "good") {
            action = B === 0
                ? "B is 0 on " + worst.axis + ": set it to about 35 (the current default) so the surface kicks against the rotation as the stick returns. Then raise I-Term Relax a step at a time if it still bounces."
                : "Raise I-Term Relax on " + worst.axis + " (Flight Feel) a step at a time" +
                  (B != null ? ", or B (now " + B + ")" : "") + ". If neither helps, the rebound is coming from the airframe rather than the controller.";
        }

        return {
            status: status,
            story: story,
            action: action,
            metrics: results.map(function(r) {
                return { label: r.axis + " bounce-back", value: Math.round(r.median * 100) + "% median, " + Math.round(r.p75 * 100) + "% p75 (" + r.count + " releases)" };
            })
        };
    }

    // ------------------------------------------------------------------
    // GYRO OFF lab -- in GYRO OFF the surfaces move by feedforward alone, so
    // the gyro shows the airframe's open-loop response to F. Informational:
    // tells the pilot how GYRO OFF compares with the stabilised modes.
    // ------------------------------------------------------------------

    var GYRO_OFF_MIN_SAMPLES_S = 5;   // seconds of usable GYRO OFF flight per axis
    var GYRO_OFF_MIN_STICK = 40;      // deg/s: samples with less stick are ignored
    var GYRO_OFF_MAX_LAG_S = 0.15;

    function analyzeGyroOffLab(ctx) {
        var bypass = ctx.masks.bypass;
        if (!bypass) return insufficient("No flight-mode data was logged for this flight.");
        var rate = ctx.sampleRateHz, n = ctx.time.length;
        var maxLag = Math.round(GYRO_OFF_MAX_LAG_S * rate), stepLag = Math.max(1, Math.round(0.005 * rate));
        var results = [];

        for (var axis = 0; axis < 2; axis++) {
            var sp = ctx.columns["setpoint[" + axis + "]"], g = ctx.columns["gyroADC[" + axis + "]"];
            if (!sp || !g) continue;
            var best = null;
            for (var lag = 0; lag <= maxLag; lag += stepLag) {
                var sxy = 0, sxx = 0, syy = 0, count = 0;
                for (var i = 0; i + lag < n; i++) {
                    var k = i + lag;
                    if (!bypass[i] || !bypass[k] || !ctx.masks.flying[i] || Math.abs(sp[i]) < GYRO_OFF_MIN_STICK) continue;
                    // Skip snaps/autorotation: the airframe running far past the stick isn't F's doing
                    if (Math.abs(g[k]) > 2 * Math.abs(sp[i]) + 50) continue;
                    sxy += sp[i] * g[k]; sxx += sp[i] * sp[i]; syy += g[k] * g[k]; count++;
                }
                if (count < GYRO_OFF_MIN_SAMPLES_S * rate || !syy) continue;
                // The lag that best lines the gyro up with the stick, and the gain at that lag
                var r = sxy / Math.sqrt(sxx * syy);
                if (!best || r > best.r) best = { r: r, gain: sxy / sxx, lag: lag / rate, count: count };
            }
            if (best) results.push({ axis: AXIS_NAMES[axis], gain: best.gain, lag: best.lag, seconds: best.count / rate });
        }

        if (!results.length) return insufficient("No GYRO OFF flight with clear stick inputs was found in this log.");

        var parts = results.map(function(r) { return r.axis + " " + Math.round(r.gain * 100) + "%"; });
        var soft = results.filter(function(r) { return r.gain < 0.7; }).map(function(r) { return r.axis; });
        var lively = results.filter(function(r) { return r.gain > 1.3; }).map(function(r) { return r.axis; });
        var feel = [];
        if (soft.length) feel.push(soft.join(" and ") + " will feel softer than in the stabilised modes, where P and I make up the rest; more F or rate on that axis closes the gap");
        if (lively.length) feel.push(lively.join(" and ") + " will feel livelier than in the stabilised modes");
        return {
            status: "info",
            story: "In GYRO OFF the model reached " + parts.join(", ") + " of the commanded rate (stick inputs over " + GYRO_OFF_MIN_STICK +
                " deg/s, snaps left out). GYRO OFF moves the surfaces by F alone" +
                (feel.length ? ": " + feel.join("; ") + "." : ", and on its own F already gives close to the commanded rate."),
            metrics: results.map(function(r) {
                return { label: r.axis + " in GYRO OFF", value: Math.round(r.gain * 100) + "% of commanded rate (" + r.seconds.toFixed(0) + " s of stick)" };
            })
        };
    }

    // ------------------------------------------------------------------
    // Verdict — rolls the labs up into up to 5 cards, mirroring
    // Blackbox_Lab's flightVerdict.js card shape.
    // ------------------------------------------------------------------

    function statusRank(status) {
        return status === "attention" ? 2 : status === "watch" ? 1 : 0;
    }

    function cardFromLab(key, title, screen, lab) {
        if (!lab || lab.status === "insufficient" || lab.status === "info") return null;

        var actionByStatus = {
            good: "Nothing to do.",
            watch: "Keep an eye on this over your next few flights.",
            attention: "Worth addressing before your next flight."
        };

        return {
            key: key,
            title: title,
            status: lab.status,
            headline: lab.story.split(/(?<=[.!?])\s/)[0],
            detail: lab.story,
            // A lab with a specific fix says so in `action`; the rest get the generic line
            action: (lab.status !== "good" && lab.action) || actionByStatus[lab.status] || "",
            screen: screen
        };
    }

    function buildVerdict(labs) {
        var cards = [
            cardFromLab("governor", "Motor Speed", "seekbar", labs.governor),
            cardFromLab("idleChop", "Idle Chop", "seekbar", labs.idleChop),
            cardFromLab("esc", "Power", "seekbar", labs.esc),
            cardFromLab("battery", "Battery", "seekbar", labs.battery),
            cardFromLab("pid", "PID Tracking", "seekbar", labs.pid),
            cardFromLab("bounce", "Bounce-Back", "seekbar", labs.bounce)
        ].filter(function(c) { return c; });

        var worst = "good";
        for (var i = 0; i < cards.length; i++) if (statusRank(cards[i].status) > statusRank(worst)) worst = cards[i].status;

        var summary;
        if (!cards.length) {
            summary = "Not enough data in this log to build a flight verdict — see the notes in each section below.";
        } else if (worst === "attention") {
            summary = "This flight has at least one thing worth addressing — see the cards below.";
        } else if (worst === "watch") {
            summary = "This flight looks reasonable overall, with a couple of things worth keeping an eye on.";
        } else {
            summary = "This flight looks healthy across everything this log lets us check.";
        }

        return { cards: cards, worst: worst, summary: summary };
    }

    // ------------------------------------------------------------------
    // Very large logs (tens of MB+) can take minutes to fully decode --
    // flightLog.getChunksInTimeRange() is a single synchronous, CPU-bound
    // call with no opportunity to yield, and pulling a whole such flight
    // freezes the tab for the duration (the same cost js/csv-exporter.js
    // pays for "export the whole log", just triggered here by default the
    // moment the dialog opens instead of on an explicit user action).
    //
    // Rather than always decoding the entire flight, cap how much we ask
    // for: above MAX_ANALYSIS_DURATION_S, use the per-I-frame activity
    // summary -- already built cheaply at log-open time, no full decode
    // needed -- to find the steadiest (lowest throttle-spread) window of
    // that length, and only decode that slice.
    // ------------------------------------------------------------------

    var MAX_ANALYSIS_DURATION_S = 240;

    function findSteadiestWindow(flightLog, windowSeconds) {
        var summary = flightLog.getActivitySummary();
        if (!summary || !summary.times || !summary.times.length) return null;

        var times = summary.times, throttle = summary.avgThrottle;
        var n = times.length;
        var windowUs = windowSeconds * 1000000;

        var bestSpread = Infinity, bestStart = null;
        var j = 0, min = Infinity, max = -Infinity;

        for (var i = 0; i < n; i++) {
            var endTime = times[i] + windowUs;
            if (endTime > times[n - 1]) break;

            // Advance the window end and track min/max throttle within it
            // (recomputed per start -- summary arrays are small, this stays cheap).
            j = i; min = Infinity; max = -Infinity;
            while (j < n && times[j] <= endTime) {
                if (throttle[j] < min) min = throttle[j];
                if (throttle[j] > max) max = throttle[j];
                j++;
            }

            var spread = max - min;
            if (spread < bestSpread) {
                bestSpread = spread;
                bestStart = times[i];
            }
        }

        return bestStart !== null ? { startTime: bestStart, endTime: bestStart + windowUs } : null;
    }

    // ------------------------------------------------------------------
    // Entry point
    // ------------------------------------------------------------------

    function build(flightLog) {
        var sysConfig = flightLog.getSysConfig();

        var minTime = flightLog.getMinTime(), maxTime = flightLog.getMaxTime();
        var totalDurationS = (maxTime - minTime) / 1000000;

        var analysisWindow = null;
        if (totalDurationS > MAX_ANALYSIS_DURATION_S) {
            analysisWindow = findSteadiestWindow(flightLog, MAX_ANALYSIS_DURATION_S);
            // No usable activity summary (unlikely) -- fall back to just the
            // first MAX_ANALYSIS_DURATION_S rather than the whole flight.
            if (!analysisWindow) analysisWindow = { startTime: minTime, endTime: minTime + MAX_ANALYSIS_DURATION_S * 1000000 };
        }

        var extracted = analysisWindow
            ? readColumns(flightLog, analysisWindow.startTime, analysisWindow.endTime)
            : readColumns(flightLog);

        // Real logs still show up with the pre-rename field names (older
        // firmware builds logged "headspeed"/"tailspeed" before they became
        // "motor1speed"/"motor2speed") -- normalize once here so every lab
        // below just sees motor1speed/motor2speed regardless of which the
        // log actually used.
        if (!extracted.columns.motor1speed && extracted.columns.headspeed) {
            extracted.columns.motor1speed = extracted.columns.headspeed;
        }
        if (!extracted.columns.motor2speed && extracted.columns.tailspeed) {
            extracted.columns.motor2speed = extracted.columns.tailspeed;
        }

        // Used as the primary stable-phase basis whenever there's no
        // governor target logged (the normal case -- see analyzeGovernorLab)
        // regardless of whether motor speed itself is present, since an
        // ungoverned prop's RPM isn't a reliable "steady" signal on its own.
        // Summed |gyro| stands in for "is the airframe actively maneuvering
        // right now".
        var gyroActivity = null;
        var gx = extracted.columns["gyroADC[0]"], gy = extracted.columns["gyroADC[1]"], gz = extracted.columns["gyroADC[2]"];
        if (gx && gy && gz) {
            gyroActivity = new Array(extracted.time.length);
            for (var gi = 0; gi < gyroActivity.length; gi++) {
                gyroActivity[gi] = Math.abs(gx[gi]) + Math.abs(gy[gi]) + Math.abs(gz[gi]);
            }
        }

        var n = extracted.time.length;
        var masks = buildModeMasks(extracted.columns, n);

        var stable = detectStableFlightPhase(extracted.time, extracted.columns.motor1speed, extracted.columns.govTarget || extracted.columns.govRequest, gyroActivity, masks.flying);

        // Samples where the rate loop was in charge: flying, no bypass or leveling mode
        var rateLoopSamples = null;
        if (masks.bypass || masks.leveling) {
            rateLoopSamples = new Array(n);
            for (var ri = 0; ri < n; ri++) {
                rateLoopSamples[ri] = masks.flying[ri] && !(masks.bypass && masks.bypass[ri]) && !(masks.leveling && masks.leveling[ri]);
            }
        }

        // Step response over the same range, for PID tracking (see analyzePidLab)
        var stepResponse = null;
        if (typeof StepResponseCalc !== "undefined") {
            StepResponseCalc.initialize(flightLog, sysConfig);
            StepResponseCalc.setInTime(analysisWindow ? analysisWindow.startTime : minTime);
            StepResponseCalc.setOutTime(analysisWindow ? analysisWindow.endTime : maxTime);
            stepResponse = StepResponseCalc.calculate();
        }

        var ctx = {
            time: extracted.time,
            columns: extracted.columns,
            stable: stable,
            masks: masks,
            rateLoopSamples: rateLoopSamples,
            sampleRateHz: n > 1 ? n / ((extracted.time[n - 1] - extracted.time[0]) || 1) : 1,
            stepResponse: stepResponse,
            sysConfig: sysConfig
        };

        var labs = {
            governor: analyzeGovernorLab(ctx),
            idleChop: analyzeIdleChopRecoveryLab(ctx),
            esc: analyzeEscLab(ctx),
            battery: analyzeBatteryLab(ctx, flightLog),
            vibration: analyzeVibrationLab(ctx, flightLog),
            thrustVector: analyzeThrustVectorLab(ctx),
            pid: analyzePidLab(ctx, flightLog),
            bounce: analyzeBounceLab(ctx),
            gyroOff: analyzeGyroOffLab(ctx)
        };

        var context = {
            craftName: sysConfig.Craft_name || "Unnamed craft",
            firmwareVersion: sysConfig.firmwareVersion || null,
            durationSeconds: totalDurationS,
            stableSeconds: stable.sampleRateHz ? stable.stableSampleCount / stable.sampleRateHz : 0,
            analyzedSeconds: analysisWindow ? (analysisWindow.endTime - analysisWindow.startTime) / 1000000 : totalDurationS,
            capped: !!analysisWindow
        };

        return { context: context, labs: labs, verdict: buildVerdict(labs) };
    }

    return { build: build };
})();
