"use strict";

/**
 * Step response estimation for the Roll/Pitch/Yaw rate loops.
 *
 * A "step response" shows how the gyro (measured rotation rate) settles onto the setpoint
 * after a sudden stick movement - fast rise, little overshoot and a quick, non-oscillatory
 * settle at 1.0 (response normalised to the setpoint) indicates good tuning; overshoot,
 * ringing or a slow crawl to 1.0 indicate tuning problems.
 *
 * Blackbox logs don't contain a deliberate step input though - just whatever the pilot did
 * in flight. So rather than looking for an actual step, this uses the same statistical
 * technique as Betaflight Blackbox Explorer / PIDtoolbox to recover it from ordinary flight
 * data:
 *
 *   1. Slice the log into many overlapping windows (STEP_RESPONSE_FRAME_LEN_SEC long,
 *      overlapping by a factor of STEP_RESPONSE_SUPERPOS) so every sample contributes to
 *      several windows and the result isn't sensitive to where a window boundary falls.
 *   2. Skip windows where the pilot barely moved the stick (peak-to-peak setpoint movement
 *      below STEP_RESPONSE_MIN_STICK_MOVEMENT) - without excitation there is nothing to
 *      deconvolve, and the divide in step 4 would just amplify noise.
 *   3. Apply a Hanning window to the setpoint and gyro signal for that window, to reduce
 *      spectral leakage from the hard edges of the slice before the FFT.
 *   4. FFT both signals and estimate the axis's frequency response H via a lightly
 *      regularised Wiener deconvolution:
 *          H(f) = G(f) * conj(X(f)) / (|X(f)|^2 + reg)
 *      where X is the setpoint spectrum and G is the gyro spectrum for this window. reg
 *      (a small fraction of the mean input power) keeps the division stable at frequencies
 *      the stick didn't excite, where |X(f)|^2 would otherwise be close to zero.
 *   5. Inverse-FFT H to get the window's impulse response, then cumulatively sum it to turn
 *      the impulse response into a step response (a step is the integral of an impulse).
 *   6. Repeat for every accepted window across the whole log, then average the per-window
 *      step responses together. Windows whose average deviation from the pointwise mean
 *      exceeds STEP_RESPONSE_OUTLIER_SIGMA standard deviations are discarded first, so a
 *      single noisy/aggressive window can't dominate the average.
 *   7. The result is only reported as "valid" once at least STEP_RESPONSE_MIN_WINDOWS
 *      windows survive rejection and the setpoint -> gyro coherence (see below) reaches
 *      STEP_RESPONSE_MIN_COHERENCE - too few windows, or a gyro that mostly isn't
 *      following the stick, and the average isn't meaningful.
 *
 * Steps 1-6 run independently for each axis in STEP_RESPONSE_AXIS_NAMES.
 *
 * Windows that don't measure the rate loop are skipped before step 3, and counted per
 * reason so the plot can say what was left out:
 *   - notFlying: the aircraft wasn't rotating (armed on the ground, stick checks). The stick
 *     moves and the gyro doesn't, which drags the response towards 0.
 *   - bypass: a mode that drives the surfaces without the gyro (GYRO OFF, SETUP) was on.
 *     The gyro then shows the airframe's open-loop response, not the tune.
 *   - leveling: ANGLE, TRAINER, ATT HOLD or a GPS/failsafe mode was on, so the logged
 *     setpoint (the stick rate) isn't what the PID tracked. On Wingflight logs with F > 0
 *     and no TPA/SPA scaling the PID's setpoint is recovered from the F term instead and
 *     the window is kept.
 *   - snap: the gyro ran past STEP_RESPONSE_SNAP_RATIO x the setpoint (a snap, pop top or
 *     stall autorotation), or the mixer sat at full travel for over
 *     STEP_RESPONSE_SAT_FRACTION of the window. Neither is the tune's response. The ratio
 *     is high enough that a tune overshooting by 50 % is still kept.
 * The mode checks use the logged box switch flags, so they apply to Wingflight and
 * Rotorflight logs that name these modes; the other checks apply to every log.
 *
 * Coherence is the magnitude-squared coherence between setpoint and gyro over
 * STEP_RESPONSE_COHERENCE_BAND, averaged across the kept windows and weighted by stick
 * power: near 1 when the gyro is a consistent function of the stick, low when it is
 * dominated by something else (cross-coupling, gusts, an axis the pilot barely flew).
 */
const
    STEP_RESPONSE_AXIS_NAMES        = ['roll', 'pitch', 'yaw'],
    STEP_RESPONSE_FRAME_LEN_SEC     = 1.0,     // length of each analysis window
    STEP_RESPONSE_SUPERPOS          = 4,       // window overlap factor (stride = frameLen / this)
    STEP_RESPONSE_LEN_SEC           = 0.5,     // length of step response to keep from each window
    STEP_RESPONSE_MIN_STICK_MOVEMENT= 20,      // deg/s peak-to-peak setpoint excitation required to accept a window
    STEP_RESPONSE_OUTLIER_SIGMA     = 2,       // reject windows deviating more than this many pointwise std-devs from the mean
    STEP_RESPONSE_MIN_WINDOWS       = 10,      // minimum accepted windows for a result to be considered valid
    STEP_RESPONSE_REG_FRACTION      = 0.01,    // Wiener deconvolution regularization, as a fraction of mean input power
    STEP_RESPONSE_MAX_LENGTH        = 300 * 1000 * 1000, // 5min, matches the Analyser's analysis length cap
    STEP_RESPONSE_MIN_COHERENCE     = 0.5,     // setpoint -> gyro coherence below this is reported as low confidence
    STEP_RESPONSE_COHERENCE_BAND    = [1, 10], // Hz, the band stick inputs actually excite
    STEP_RESPONSE_SNAP_RATIO        = 2.0,     // gyro peak above this x the setpoint peak marks a snap/autorotation
    STEP_RESPONSE_SNAP_MIN_RATE     = 50,      // deg/s floor on the setpoint peak for that test, so small inputs aren't flagged
    STEP_RESPONSE_SAT_LEVEL         = 990,     // |mixer| (x1000) counted as full travel
    STEP_RESPONSE_SAT_FRACTION      = 0.05,    // share of a window at full travel that marks it saturated
    STEP_RESPONSE_ROTATING_RATE     = 40,      // deg/s, |roll| + |pitch| gyro counted as rotating
    STEP_RESPONSE_ROTATING_SPAN_SEC = 2,       // +- seconds around a sample searched for rotation
    STEP_RESPONSE_ROTATING_FRACTION = 0.05,    // share of that span that must be rotating to count as flying
    STEP_RESPONSE_BYPASS_MODES      = ['GYRO OFF', 'SETUP', 'MANUAL', 'PASSTHROUGH'],
    STEP_RESPONSE_LEVELING_MODES    = ['ANGLE', 'HORIZON', 'TRAINER', 'ATTHOLD', 'GPSRESCUE', 'RESCUE', 'LOITER', 'RTH', 'FAILSAFE'],
    STEP_RESPONSE_F_TERM_SCALE      = 0.000025; // Wingflight ROLL/PITCH/YAW_F_TERM_SCALE (src/main/flight/pid.h)

var StepResponseCalc = StepResponseCalc || {
    _timeRange : {
            in: 0,
            out: 0
    },
    _blackBoxRate : 0,
    _flightLog : null,
    _sysConfig : null,
};

// Derives the effective blackbox sample rate (Hz) from the log's looptime/decimation
// config, so window lengths below can be expressed in seconds rather than samples.
StepResponseCalc.initialize = function(flightLog, sysConfig) {

    this._flightLog = flightLog;
    this._sysConfig = sysConfig;

    var gyroRate = (1000000 / this._sysConfig['looptime']).toFixed(0);
    this._blackBoxRate = gyroRate * this._sysConfig['frameIntervalPNum'] / this._sysConfig['frameIntervalPDenom'];
    if (this._sysConfig.pid_process_denom != null) {
        this._blackBoxRate = this._blackBoxRate / this._sysConfig.pid_process_denom;
    }
};

StepResponseCalc.setInTime = function(time) {
    this._timeRange.in = time;
    return this._timeRange.in;
};

StepResponseCalc.setOutTime = function(time) {
    if ((time - this._timeRange.in) <= STEP_RESPONSE_MAX_LENGTH) {
        this._timeRange.out = time;
    } else {
        this._timeRange.out = this._timeRange.in + STEP_RESPONSE_MAX_LENGTH;
    }
    return this._timeRange.out;
};

/**
 * Calculates the averaged step response (setpoint -> gyro) for roll, pitch and yaw
 * over the currently configured time range, via windowed Wiener deconvolution.
 *
 * Returns { roll, pitch, yaw }, each { time, response, windowCount, valid, coherence,
 * excluded: { notFlying, bypass, leveling, snap } }.
 */
StepResponseCalc.calculate = function() {
    var samples = this._getSamples();
    var result = {};
    for (var axisIndex = 0; axisIndex < STEP_RESPONSE_AXIS_NAMES.length; axisIndex++) {
        result[STEP_RESPONSE_AXIS_NAMES[axisIndex]] = this._calculateAxis(axisIndex, samples);
    }
    return result;
};

// Fetches the raw log chunks for the currently configured [in, out) time range, clamped
// to STEP_RESPONSE_MAX_LENGTH so a huge selection can't blow up the FFT work below.
StepResponseCalc._getFlightChunks = function() {

    var logStart = this._timeRange.in || this._flightLog.getMinTime();
    var logEnd = this._timeRange.out || this._flightLog.getMaxTime();

    logEnd = (logEnd - logStart <= STEP_RESPONSE_MAX_LENGTH) ? logEnd : logStart + STEP_RESPONSE_MAX_LENGTH;

    return this._flightLog.getChunksInTimeRange(logStart, logEnd);
};

// Value of a header line the parser didn't recognise (kept in sysConfig.unknownHeaders),
// or null when the log doesn't have it.
StepResponseCalc._unknownHeader = function(name) {
    var headers = this._sysConfig.unknownHeaders || [];
    for (var i = 0; i < headers.length; i++) {
        if (headers[i].name === name) {
            return String(headers[i].value);
        }
    }
    return null;
};

// Bits of the named modes in this log's flight mode table (FLIGHT_LOG_FLIGHT_MODE_NAME,
// which matches flightModeFlags/flightModeFlags2 for the log's firmware).
StepResponseCalc._modeBits = function(names) {
    var table = (typeof FLIGHT_LOG_FLIGHT_MODE_NAME !== 'undefined') ? FLIGHT_LOG_FLIGHT_MODE_NAME : [];
    var bits = [];
    for (var i = 0; i < names.length; i++) {
        var bit = table.indexOf(names[i]);
        if (bit >= 0) bits.push(bit);
    }
    return bits;
};

// True when any of `bits` is set in the 64-bit mode mask split over two words. Plain
// arithmetic, since JS bit operators work on signed 32 bits.
StepResponseCalc._anyBit = function(flags1, flags2, bits) {
    for (var i = 0; i < bits.length; i++) {
        var bit = bits[i];
        var word = bit < 32 ? flags1 : flags2;
        if (Math.floor(word / Math.pow(2, bit % 32)) % 2 === 1) return true;
    }
    return false;
};

// Kf for an axis when the PID's setpoint can be recovered from the logged F term
// (axisF = Kf x setpoint x 1000), else 0. Only on Wingflight logs with F > 0 and the
// throttle and GPS speed attenuation at 100 % with no curve, since those scale F too.
StepResponseCalc._recoverableKf = function(axisIndex) {
    if (this._sysConfig.firmwareType !== FIRMWARE_TYPE_WINGFLIGHT) return 0;
    var tpa = this._unknownHeader('fw_tpa');
    if (tpa === null || tpa.replace(/\s/g, '') !== '100,0') return 0;
    var spa = this._unknownHeader('fw_spa');
    if (spa !== null && !/^100,0(,|$)/.test(spa.replace(/\s/g, ''))) return 0;
    var pid = this._sysConfig[['rollPID', 'pitchPID', 'yawPID'][axisIndex]];
    var F = pid && pid[3];
    return F > 0 ? STEP_RESPONSE_F_TERM_SCALE * F : 0;
};

// Flattens the selected range into contiguous per-sample arrays for every axis
// (setpoint, gyro, and where logged mixer and F term), plus per-sample masks used to
// skip windows: flying (see STEP_RESPONSE_ROTATING_*), bypass and leveling. Prefix sums
// of the masks let a window be tested in O(1).
StepResponseCalc._getSamples = function() {

    var log = this._flightLog;
    var allChunks = this._getFlightChunks();

    var idx = function(name) {
        var i = log.getMainFieldIndexByName(name);
        return (i === undefined) ? null : i;
    };

    var fields = [];
    for (var axis = 0; axis < 3; axis++) {
        fields.push({
            setpoint: idx('setpoint[' + axis + ']'),
            gyro: idx('gyroADC[' + axis + ']'),
            mixer: idx('mixer[' + axis + ']'),
            axisF: idx('axisF[' + axis + ']'),
        });
    }
    var FLAGS1 = idx('flightModeFlags'), FLAGS2 = idx('flightModeFlags2');

    var maxSamples = Math.ceil(STEP_RESPONSE_MAX_LENGTH / (1000 * 1000) * this._blackBoxRate);
    var axes = fields.map(function(f) {
        return {
            present: f.setpoint !== null && f.gyro !== null,
            setpoint: new Float64Array(maxSamples),
            gyro: new Float64Array(maxSamples),
            mixer: f.mixer !== null ? new Float64Array(maxSamples) : null,
            axisF: f.axisF !== null ? new Float64Array(maxSamples) : null,
        };
    });
    var bypass = new Uint8Array(maxSamples);
    var leveling = new Uint8Array(maxSamples);

    var bypassBits = this._modeBits(STEP_RESPONSE_BYPASS_MODES);
    var levelingBits = this._modeBits(STEP_RESPONSE_LEVELING_MODES);

    // The flags come from slow frames and rarely change, so test the bits only on a change
    var lastFlags1 = null, lastFlags2 = null, lastBypass = 0, lastLeveling = 0;

    var count = 0;
    for (var chunkIndex = 0; chunkIndex < allChunks.length && count < maxSamples; chunkIndex++) {
        var frames = allChunks[chunkIndex].frames;
        for (var frameIndex = 0; frameIndex < frames.length && count < maxSamples; frameIndex++) {
            var frame = frames[frameIndex];
            for (var a = 0; a < 3; a++) {
                var f = fields[a], s = axes[a];
                if (!s.present) continue;
                s.setpoint[count] = frame[f.setpoint];
                s.gyro[count] = frame[f.gyro];
                if (s.mixer) s.mixer[count] = frame[f.mixer];
                if (s.axisF) s.axisF[count] = frame[f.axisF];
            }
            var flags1 = FLAGS1 !== null ? (frame[FLAGS1] || 0) : 0;
            var flags2 = FLAGS2 !== null ? (frame[FLAGS2] || 0) : 0;
            if (flags1 !== lastFlags1 || flags2 !== lastFlags2) {
                lastFlags1 = flags1;
                lastFlags2 = flags2;
                lastBypass = this._anyBit(flags1, flags2, bypassBits) ? 1 : 0;
                lastLeveling = this._anyBit(flags1, flags2, levelingBits) ? 1 : 0;
            }
            bypass[count] = lastBypass;
            leveling[count] = lastLeveling;
            count++;
        }
    }

    // Flying: some roll/pitch rotation within +- ROTATING_SPAN of the sample
    var rotating = new Float64Array(count + 1);
    for (var i = 0; i < count; i++) {
        var rate = Math.abs(axes[0].present ? axes[0].gyro[i] : 0) + Math.abs(axes[1].present ? axes[1].gyro[i] : 0);
        rotating[i + 1] = rotating[i] + (rate > STEP_RESPONSE_ROTATING_RATE ? 1 : 0);
    }
    var span = Math.round(STEP_RESPONSE_ROTATING_SPAN_SEC * this._blackBoxRate);
    var notFlyingSum = new Float64Array(count + 1);
    var bypassSum = new Float64Array(count + 1);
    var levelingSum = new Float64Array(count + 1);
    for (var j = 0; j < count; j++) {
        var lo = Math.max(0, j - span), hi = Math.min(count, j + span);
        var flying = (rotating[hi] - rotating[lo]) > STEP_RESPONSE_ROTATING_FRACTION * (hi - lo);
        notFlyingSum[j + 1] = notFlyingSum[j] + (flying ? 0 : 1);
        bypassSum[j + 1] = bypassSum[j] + bypass[j];
        levelingSum[j + 1] = levelingSum[j] + leveling[j];
    }

    return {
        count: count,
        axes: axes,
        leveling: leveling,
        notFlyingSum: notFlyingSum,
        bypassSum: bypassSum,
        levelingSum: levelingSum,
    };
};

// The setpoint the PID actually tracked for an axis: the logged stick setpoint, or in
// leveling modes the one recovered from F when that is possible. `recovered` false means
// leveling windows can't be used for this axis.
StepResponseCalc._effectiveSetpoint = function(axisIndex, samples) {
    var s = samples.axes[axisIndex];
    var Kf = s.axisF ? this._recoverableKf(axisIndex) : 0;
    if (!Kf) {
        return { setpoint: s.setpoint, recovered: false };
    }
    var setpoint = new Float64Array(samples.count);
    for (var i = 0; i < samples.count; i++) {
        setpoint[i] = samples.leveling[i] ? s.axisF[i] / 1000 / Kf : s.setpoint[i];
    }
    return { setpoint: setpoint, recovered: true };
};

// Why a window can't be used, or null. See the file header for each reason.
StepResponseCalc._windowExclusion = function(samples, axisIndex, start, frameLen, recovered) {
    var end = start + frameLen;
    if (samples.notFlyingSum[end] - samples.notFlyingSum[start] > 0) return 'notFlying';
    if (samples.bypassSum[end] - samples.bypassSum[start] > 0) return 'bypass';
    if (!recovered && samples.levelingSum[end] - samples.levelingSum[start] > 0) return 'leveling';
    return null;
};

// Snap/autorotation or a saturated surface in this window (see the file header).
StepResponseCalc._isSnapOrSaturated = function(setpointWindow, gyroWindow, mixer, start, frameLen) {
    var spPeak = 0, gyroPeak = 0;
    for (var i = 0; i < frameLen; i++) {
        spPeak = Math.max(spPeak, Math.abs(setpointWindow[i]));
        gyroPeak = Math.max(gyroPeak, Math.abs(gyroWindow[i]));
    }
    if (gyroPeak > STEP_RESPONSE_SNAP_RATIO * Math.max(spPeak, STEP_RESPONSE_SNAP_MIN_RATE)) {
        return true;
    }
    if (mixer) {
        var saturated = 0;
        for (var j = start; j < start + frameLen; j++) {
            if (Math.abs(mixer[j]) >= STEP_RESPONSE_SAT_LEVEL) saturated++;
        }
        if (saturated > STEP_RESPONSE_SAT_FRACTION * frameLen) return true;
    }
    return false;
};

// Applies a Hanning window in-place, tapering both ends of the slice to zero so the FFT
// below doesn't see the sharp discontinuities at the window edges as spurious frequency
// content (spectral leakage).
StepResponseCalc._hanningWindow = function(samples, size) {
    for (var i = 0; i < size; i++) {
        samples[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
};

// Placeholder "no data" result (flat zero response, 0 windows) for when an axis can't be
// analysed at all, e.g. the fields are missing from the log or there aren't enough samples.
StepResponseCalc._emptyResult = function(timeAxis, responseLenSamples, excluded) {
    return {
        time: timeAxis,
        response: new Float64Array(responseLenSamples),
        windowCount: 0,
        valid: false,
        coherence: null,
        excluded: excluded || { notFlying: 0, bypass: 0, leveling: 0, snap: 0 },
    };
};

// Computes the averaged step response for a single axis. See the file header for the
// overall approach; this is the per-window windowing/FFT/Wiener-deconvolution/averaging
// pipeline (steps 1-7) run for one of roll/pitch/yaw.
StepResponseCalc._calculateAxis = function(axisIndex, samples) {

    // responseLenSamples/timeAxis describe the fixed-length output curve (0..STEP_RESPONSE_LEN_SEC)
    // that every window's step response gets trimmed/averaged down to.
    var responseLenSamples = Math.round(STEP_RESPONSE_LEN_SEC * this._blackBoxRate);
    var timeAxis = new Float64Array(responseLenSamples);
    for (var t = 0; t < responseLenSamples; t++) {
        timeAxis[t] = t / this._blackBoxRate;
    }

    // Each analysis window is FRAME_LEN_SEC long; it must be at least as long as the step
    // response we want to keep from it.
    var frameLen = Math.round(STEP_RESPONSE_FRAME_LEN_SEC * this._blackBoxRate);

    if (frameLen < responseLenSamples || frameLen < 2) {
        return this._emptyResult(timeAxis, responseLenSamples);
    }

    var axisSamples = samples.axes[axisIndex];

    if (!axisSamples.present || samples.count < frameLen) {
        return this._emptyResult(timeAxis, responseLenSamples);
    }

    var effective = this._effectiveSetpoint(axisIndex, samples);
    var excluded = { notFlying: 0, bypass: 0, leveling: 0, snap: 0 };

    // Cross- and auto-spectra summed over kept windows, for the coherence estimate
    var bandLo = Math.ceil(STEP_RESPONSE_COHERENCE_BAND[0] * frameLen / this._blackBoxRate);
    var bandHi = Math.min(Math.floor(STEP_RESPONSE_COHERENCE_BAND[1] * frameLen / this._blackBoxRate), frameLen / 2);
    var bandLen = Math.max(0, bandHi - bandLo + 1);
    var SxyR = new Float64Array(bandLen), SxyI = new Float64Array(bandLen);
    var Sxx = new Float64Array(bandLen), Syy = new Float64Array(bandLen);

    // Windows step forward by a fraction of their own length (SUPERPOS-way overlap), so
    // consecutive windows share most of their samples rather than being independent slices.
    var stride = Math.max(1, Math.round(frameLen / STEP_RESPONSE_SUPERPOS));

    var forwardFft = new FFT.complex(frameLen, false);
    var inverseFft = new FFT.complex(frameLen, true);

    var windowResponses = [];

    for (var start = 0; start + frameLen <= samples.count; start += stride) {

        var setpointWindow = effective.setpoint.slice(start, start + frameLen);
        var gyroWindow = axisSamples.gyro.slice(start, start + frameLen);

        // Reject windows without enough stick excitation - deconvolution is meaningless without input
        var minSp = setpointWindow[0], maxSp = setpointWindow[0];
        for (var s = 1; s < frameLen; s++) {
            if (setpointWindow[s] < minSp) minSp = setpointWindow[s];
            if (setpointWindow[s] > maxSp) maxSp = setpointWindow[s];
        }
        if ((maxSp - minSp) < STEP_RESPONSE_MIN_STICK_MOVEMENT) {
            continue;
        }

        // Skip windows that don't measure the rate loop, counting why
        var reason = this._windowExclusion(samples, axisIndex, start, frameLen, effective.recovered);
        if (!reason && this._isSnapOrSaturated(setpointWindow, gyroWindow, axisSamples.mixer, start, frameLen)) {
            reason = 'snap';
        }
        if (reason) {
            excluded[reason]++;
            continue;
        }

        this._hanningWindow(setpointWindow, frameLen);
        this._hanningWindow(gyroWindow, frameLen);

        var X = new Float64Array(frameLen * 2); // setpoint spectrum
        var G = new Float64Array(frameLen * 2); // gyro spectrum
        forwardFft.simple(X, setpointWindow, 'real');
        forwardFft.simple(G, gyroWindow, 'real');

        // Regularization proportional to mean input power, avoids dividing by (near) zero
        // at frequencies the stick didn't excite.
        var meanPower = 0;
        for (var f = 0; f < frameLen; f++) {
            meanPower += X[2 * f] * X[2 * f] + X[2 * f + 1] * X[2 * f + 1];
        }
        meanPower /= frameLen;
        var reg = STEP_RESPONSE_REG_FRACTION * meanPower + 1e-9;

        // Wiener deconvolution: H = G * conj(X) / (X * conj(X) + reg)
        var H = new Float64Array(frameLen * 2);
        for (var k = 0; k < frameLen; k++) {
            var xr = X[2 * k], xi = X[2 * k + 1];
            var gr = G[2 * k], gi = G[2 * k + 1];

            var denom = xr * xr + xi * xi + reg;

            var numR = gr * xr + gi * xi;
            var numI = gi * xr - gr * xi;

            H[2 * k] = numR / denom;
            H[2 * k + 1] = numI / denom;
        }

        var impulse = new Float64Array(frameLen * 2);
        inverseFft.simple(impulse, H, 'complex');

        // Cumulative sum of the impulse response gives the step response. This library's
        // inverse transform is unnormalized (verified empirically), so divide by frameLen.
        var stepResponse = new Float64Array(responseLenSamples);
        var acc = 0;
        var windowIsFinite = true;
        for (var n = 0; n < responseLenSamples; n++) {
            acc += impulse[2 * n] / frameLen;
            stepResponse[n] = acc;
            if (!isFinite(acc)) windowIsFinite = false;
        }

        // A dropped/corrupted frame (NaN or Infinity in the raw setpoint or gyro data for this
        // window) poisons the whole window's FFT output. Since the FFT is a transform over the
        // entire window, this isn't recoverable per-sample - discard the window rather than
        // letting a single bad window contaminate the averaged result for every other window.
        if (!windowIsFinite) {
            continue;
        }

        for (var b = 0; b < bandLen; b++) {
            var bin = bandLo + b;
            var sr = X[2 * bin], si = X[2 * bin + 1];
            var yr = G[2 * bin], yi = G[2 * bin + 1];
            SxyR[b] += yr * sr + yi * si;
            SxyI[b] += yi * sr - yr * si;
            Sxx[b] += sr * sr + si * si;
            Syy[b] += yr * yr + yi * yi;
        }

        windowResponses.push(stepResponse);
    }

    if (windowResponses.length === 0) {
        return this._emptyResult(timeAxis, responseLenSamples, excluded);
    }

    // Stick-power-weighted mean of the per-bin magnitude-squared coherence
    var cohSum = 0, cohWeight = 0;
    for (var c = 0; c < bandLen; c++) {
        if (Sxx[c] <= 0 || Syy[c] <= 0) continue;
        var coh = (SxyR[c] * SxyR[c] + SxyI[c] * SxyI[c]) / (Sxx[c] * Syy[c]);
        cohSum += coh * Sxx[c];
        cohWeight += Sxx[c];
    }
    var coherence = cohWeight > 0 ? cohSum / cohWeight : null;

    // Pointwise mean and std-dev across all accepted windows
    var mean = new Float64Array(responseLenSamples);
    for (var w = 0; w < windowResponses.length; w++) {
        for (var n = 0; n < responseLenSamples; n++) {
            mean[n] += windowResponses[w][n];
        }
    }
    for (var n = 0; n < responseLenSamples; n++) {
        mean[n] /= windowResponses.length;
    }

    var std = new Float64Array(responseLenSamples);
    for (var w = 0; w < windowResponses.length; w++) {
        for (var n = 0; n < responseLenSamples; n++) {
            var d = windowResponses[w][n] - mean[n];
            std[n] += d * d;
        }
    }
    for (var n = 0; n < responseLenSamples; n++) {
        std[n] = Math.sqrt(std[n] / windowResponses.length);
    }

    // Single-pass outlier rejection: drop windows whose average deviation from the mean
    // (in units of the pointwise std-dev) exceeds STEP_RESPONSE_OUTLIER_SIGMA
    var accepted = [];
    for (var w = 0; w < windowResponses.length; w++) {
        var totalDeviation = 0;
        var countedPoints = 0;
        for (var n = 0; n < responseLenSamples; n++) {
            if (std[n] > 1e-9) {
                totalDeviation += Math.abs(windowResponses[w][n] - mean[n]) / std[n];
                countedPoints++;
            }
        }
        if (countedPoints === 0 || (totalDeviation / countedPoints) <= STEP_RESPONSE_OUTLIER_SIGMA) {
            accepted.push(windowResponses[w]);
        }
    }

    if (accepted.length === 0) {
        // Rejection removed every window (e.g. a very noisy log) - fall back to using them
        // all rather than reporting no data.
        accepted = windowResponses;
    }

    // Final pointwise average of the accepted (outlier-filtered) per-window step responses.
    var finalResponse = new Float64Array(responseLenSamples);
    for (var w = 0; w < accepted.length; w++) {
        for (var n = 0; n < responseLenSamples; n++) {
            finalResponse[n] += accepted[w][n];
        }
    }
    for (var n = 0; n < responseLenSamples; n++) {
        finalResponse[n] /= accepted.length;
    }

    return {
        time: timeAxis,
        response: finalResponse,
        windowCount: accepted.length,
        valid: accepted.length >= STEP_RESPONSE_MIN_WINDOWS
            && coherence !== null && coherence >= STEP_RESPONSE_MIN_COHERENCE,
        coherence: coherence,
        excluded: excluded,
    };
};
