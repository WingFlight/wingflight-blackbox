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
        "Vbat", "Ibat",
        "EscV", "EscI", "EscThr", "EscCap",
        "motor[0]",
        "tvAxisP[0]", "tvAxisP[1]", "tvAxisP[2]",
        "tvAxisI[0]", "tvAxisI[1]", "tvAxisI[2]",
        "tvAxisD[0]", "tvAxisD[1]", "tvAxisD[2]",
        "tvAxisF[0]", "tvAxisF[1]", "tvAxisF[2]",
        "tvAxisB[0]", "tvAxisB[1]", "tvAxisB[2]"
    ];

    function readColumns(flightLog) {
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
        var chunks = flightLog.getChunksInTimeRange(flightLog.getMinTime(), flightLog.getMaxTime());

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

    function detectStableFlightPhase(time, motorSpeed, governorTarget, gyroActivity) {
        var n = time.length;

        if (n < 50 || time[n - 1] - time[0] <= 0) {
            return { stableIndexes: [], stableSampleCount: 0, reason: "This flight is too short to analyze." };
        }

        var hasMotorSpeed = false;
        if (motorSpeed) {
            for (var h = 0; h < n; h++) if (motorSpeed[h] > 500) { hasMotorSpeed = true; break; }
        }

        var sampleRateHz = n / (time[n - 1] - time[0]);
        var windowSamples = Math.max(1, Math.round(sampleRateHz * 2)); // +-2s

        var candidate = new Array(n);
        var i, lo, hi;
        var basis;

        if (hasMotorSpeed) {
            // Preferred basis: an aircraft with a speed-governed motor gives
            // a direct, precise read on "steady" (target barely moving,
            // actual speed tracking it closely); without a target, fall back
            // to a plateau check on the speed signal itself.
            basis = "motor-speed";

            for (i = 0; i < n; i++) {
                var speed = motorSpeed[i];
                candidate[i] = false;
                if (speed < 500) continue;

                lo = Math.max(0, i - windowSamples);
                hi = Math.min(n - 1, i + windowSamples);

                if (governorTarget && governorTarget[i] > 500) {
                    var targetSpread = spread(governorTarget, lo, hi);
                    var trackingError = Math.abs(governorTarget[i] - speed) / governorTarget[i];
                    candidate[i] = targetSpread < 20 && trackingError <= 0.08;
                } else {
                    var speedSpread = spread(motorSpeed, lo, hi);
                    candidate[i] = speedSpread < Math.max(40, speed * 0.03);
                }
            }

            // Blank out +-2s windows around governor-target steps
            if (governorTarget) {
                for (i = 1; i < n; i++) {
                    if (Math.abs(governorTarget[i] - governorTarget[i - 1]) > 20) {
                        lo = Math.max(0, i - windowSamples);
                        hi = Math.min(n - 1, i + windowSamples);
                        for (var j = lo; j <= hi; j++) candidate[j] = false;
                    }
                }
            }
        } else if (gyroActivity) {
            // No motor-speed telemetry at all (common on simple throttle-only
            // setups) -- fall back to airframe motion: a period where the
            // aircraft is flying level/steady (not actively maneuvering)
            // shows up as a sustained low-and-flat patch on summed |gyro|.
            basis = "gyro-activity";

            var smoothed = movingAverage(gyroActivity, Math.round(sampleRateHz));
            var sorted = smoothed.slice(0).sort(function(a, b) { return a - b; });
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
        } else {
            return { stableIndexes: [], stableSampleCount: 0, reason: "No motor-speed or gyro data logged, so a steady-flight window can't be identified." };
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
        return target ? analyzeGovernorAgainstTarget(speedStable, pickAtIndexes(target, idx)) : analyzeGovernorSteadiness(speedStable);
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
    function analyzeGovernorSteadiness(speedStable) {
        var avgSpeed = average(speedStable);
        var maxDeviation = 0;
        var deviations = new Array(speedStable.length);
        for (var i = 0; i < speedStable.length; i++) {
            var deviation = speedStable[i] - avgSpeed;
            deviations[i] = deviation;
            if (Math.abs(deviation) > maxDeviation) maxDeviation = Math.abs(deviation);
        }
        var rmsDeviation = rms(deviations);
        var variabilityPercent = avgSpeed ? (maxDeviation / avgSpeed) * 100 : 0;

        var status = variabilityPercent > 3 ? "attention" : variabilityPercent > 1.2 ? "watch" : "good";

        var caveat = " (This firmware doesn't log a governor target, so this reflects motor-speed steadiness, not tracking accuracy.)";
        var story;
        if (status === "good") {
            story = "Motor speed held steady during stable flight: averaged " + Math.round(avgSpeed) +
                " rpm, straying by at most " + Math.round(maxDeviation) + " rpm (" + variabilityPercent.toFixed(1) + "%)." + caveat;
        } else if (status === "watch") {
            story = "Motor speed mostly held steady, but wandered as much as " + Math.round(maxDeviation) + " rpm (" +
                variabilityPercent.toFixed(1) + "%) during stable flight — worth keeping an eye on." + caveat;
        } else {
            story = "Motor speed varied noticeably during stable flight: up to " + Math.round(maxDeviation) + " rpm (" +
                variabilityPercent.toFixed(1) + "%) away from its average. Consider more governor gain, or check for a power-system limit." + caveat;
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

    function analyzePidLab(ctx, flightLog) {
        var haveError = false;
        for (var a = 0; a < 3; a++) if (ctx.columns["axisError[" + a + "]"]) haveError = true;
        if (!haveError) return insufficient("No setpoint/gyro tracking data was logged for this flight.");
        if (ctx.stable.stableSampleCount < MIN_STABLE_SAMPLES) return insufficient(ctx.stable.reason);

        var idx = ctx.stable.stableIndexes;
        var sysConfig = flightLog.getSysConfig();
        var pidSumLimit = { 0: sysConfig.pidSumLimit, 1: sysConfig.pidSumLimit, 2: sysConfig.pidSumLimitYaw };

        var axisResults = [];
        var worstTrackingPercent = -1, worstAxis = null;
        var worstSaturationPercent = 0, saturatedAxis = null;

        for (var axis = 0; axis < 3; axis++) {
            var errorField = ctx.columns["axisError[" + axis + "]"];
            var setpointField = ctx.columns["setpoint[" + axis + "]"];
            if (!errorField) continue;

            var errorStable = pickAtIndexes(errorField, idx);
            var rmsError = rms(errorStable);

            var trackingPercent = null;
            if (setpointField) {
                var setpointStable = pickAtIndexes(setpointField, idx);
                var activeError = [], activeSetpoint = [];
                for (var i = 0; i < setpointStable.length; i++) {
                    if (Math.abs(setpointStable[i]) > 5) {
                        activeError.push(errorStable[i]);
                        activeSetpoint.push(setpointStable[i]);
                    }
                }
                if (activeSetpoint.length > 20) {
                    var rmsSetpoint = rms(activeSetpoint);
                    trackingPercent = rmsSetpoint ? (rms(activeError) / rmsSetpoint) * 100 : null;
                }
            }

            if (trackingPercent !== null && trackingPercent > worstTrackingPercent) {
                worstTrackingPercent = trackingPercent;
                worstAxis = AXIS_NAMES[axis];
            }

            var saturationPercent = null;
            var sumField = ctx.columns["axisSum[" + axis + "]"];
            var limit = pidSumLimit[axis];
            if (sumField && limit) {
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
                rmsError: rmsError,
                trackingPercent: trackingPercent,
                saturationPercent: saturationPercent
            });
        }

        if (!axisResults.length) return insufficient("Not enough tracking data to assess PID performance.");

        var status = "good";
        if (worstTrackingPercent > 35 || worstSaturationPercent > 5) status = "attention";
        else if (worstTrackingPercent > 20 || worstSaturationPercent > 1) status = "watch";

        var storyParts = [];
        if (worstAxis) {
            storyParts.push(worstAxis + " has the highest tracking error during stable flight (" +
                worstTrackingPercent.toFixed(0) + "% of the commanded rate).");
        }
        if (saturatedAxis && worstSaturationPercent > 1) {
            storyParts.push(saturatedAxis + "'s PID sum sat near its configured limit for " +
                worstSaturationPercent.toFixed(1) + "% of stable flight — the controller had little headroom left there.");
        }
        if (!storyParts.length) {
            storyParts.push("Roll, pitch and yaw all tracked their commands closely during stable flight, with no sign of PID-sum saturation.");
        }

        return {
            status: status,
            story: storyParts.join(" "),
            metrics: axisResults.map(function(r) {
                return {
                    label: r.axis + " tracking",
                    value: (r.trackingPercent !== null ? r.trackingPercent.toFixed(0) + "% error" : Math.round(r.rmsError) + " deg/s RMS error") +
                        (r.saturationPercent !== null ? ", " + r.saturationPercent.toFixed(1) + "% saturated" : "")
                };
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
            action: actionByStatus[lab.status] || "",
            screen: screen
        };
    }

    function buildVerdict(labs) {
        var cards = [
            cardFromLab("governor", "Motor Speed", "seekbar", labs.governor),
            cardFromLab("esc", "Power", "seekbar", labs.esc),
            cardFromLab("battery", "Battery", "seekbar", labs.battery),
            cardFromLab("pid", "PID Tracking", "seekbar", labs.pid)
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
    // Entry point
    // ------------------------------------------------------------------

    function build(flightLog) {
        var sysConfig = flightLog.getSysConfig();
        var extracted = readColumns(flightLog);

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

        // Only needed as a fallback when there's no motor-speed telemetry at
        // all (simple throttle-only setups) -- summed |gyro| as a proxy for
        // "is the airframe actively maneuvering right now".
        var gyroActivity = null;
        if (!extracted.columns.motor1speed) {
            var gx = extracted.columns["gyroADC[0]"], gy = extracted.columns["gyroADC[1]"], gz = extracted.columns["gyroADC[2]"];
            if (gx && gy && gz) {
                gyroActivity = new Array(extracted.time.length);
                for (var gi = 0; gi < gyroActivity.length; gi++) {
                    gyroActivity[gi] = Math.abs(gx[gi]) + Math.abs(gy[gi]) + Math.abs(gz[gi]);
                }
            }
        }

        var stable = detectStableFlightPhase(extracted.time, extracted.columns.motor1speed, extracted.columns.govTarget || extracted.columns.govRequest, gyroActivity);

        var ctx = { time: extracted.time, columns: extracted.columns, stable: stable };

        var labs = {
            governor: analyzeGovernorLab(ctx),
            esc: analyzeEscLab(ctx),
            battery: analyzeBatteryLab(ctx, flightLog),
            vibration: analyzeVibrationLab(ctx, flightLog),
            thrustVector: analyzeThrustVectorLab(ctx),
            pid: analyzePidLab(ctx, flightLog)
        };

        var context = {
            craftName: sysConfig.Craft_name || "Unnamed craft",
            firmwareVersion: sysConfig.firmwareVersion || null,
            durationSeconds: extracted.time.length ? (extracted.time[extracted.time.length - 1] - extracted.time[0]) : 0,
            stableSeconds: stable.sampleRateHz ? stable.stableSampleCount / stable.sampleRateHz : 0
        };

        return { context: context, labs: labs, verdict: buildVerdict(labs) };
    }

    return { build: build };
})();
