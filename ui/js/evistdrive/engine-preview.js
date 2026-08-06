// evistdrive/engine-preview.js — Engine behavior preview simulation
// Pure logic layer: takes settings and scenario, outputs normalized chart data (0–1).
// This is independent of UI/Plotly, so telemetry can be plugged in later.

export function simulateRide(settings, scenario) {
    const time = Array.from({ length: 101 }, (_, i) => i * 0.1); // 0–10 sec in 0.1s steps
    const sim = { time, rawDemand: [], filteredDemand: [], rampedCurrent: [], finalCurrent: [], cadence: [], pedalLoad: [], limitActive: [], events: [] };

    // Sample scenario: returns { pedalLoad, cadence, baseAid } for each time step (0–1 range)
    const sceneData = generateScenario(scenario, time.length);

    // 1. Start condition check
    let assistStarted = false;
    let assistStartTime = null;

    // 2. Main simulation loop
    for (let i = 0; i < time.length; i++) {
        const t = time[i];
        const pedal = sceneData.pedalLoad[i];
        const rpm = sceneData.cadence[i];
        const baseAid = sceneData.baseAid[i];

        // Check if assist should start
        if (!assistStarted && canStartAssist(pedal, rpm, settings)) {
            assistStarted = true;
            assistStartTime = t;
            sim.events.push({ time: t, type: 'assist_start' });
        }

        // If assist not started yet, all demands are 0
        if (!assistStarted) {
            sim.rawDemand.push(0);
            sim.filteredDemand.push(0);
            sim.rampedCurrent.push(0);
            sim.finalCurrent.push(0);
            sim.cadence.push(rpm);
            sim.pedalLoad.push(pedal);
            sim.limitActive.push(null);
            continue;
        }

        // Raw demand from user + startup boost
        let demand = baseAid;
        if (assistStarted && assistStartTime !== null) {
            const timeSinceStart = t - assistStartTime;
            const boostFade = calculateBoostFade(timeSinceStart, rpm, settings);
            demand = Math.min(1, demand + (settings.startup_boost_strength_pct || 0) / 100 * boostFade);
        }
        sim.rawDemand.push(demand);

        // Smooth start (ramp in from 0 to demand at start)
        let smoothedDemand = demand;
        if (assistStarted && assistStartTime !== null) {
            const timeSinceStart = t - assistStartTime;
            const smoothDuration = (settings.smooth_start_duration_ms || 0) / 1000;
            if (smoothDuration > 0 && timeSinceStart < smoothDuration) {
                smoothedDemand = demand * (timeSinceStart / smoothDuration);
            }
        }

        // Power rise/fall filters (smooth short spikes/dips)
        const prevFiltered = sim.filteredDemand[i - 1] ?? 0;
        const isRising = smoothedDemand > prevFiltered;
        let filteredDemand = applyPowerFilters(smoothedDemand, prevFiltered, settings, isRising, 100);
        sim.filteredDemand.push(filteredDemand);

        // Current ramp (iq_rise_slow/fast based on cadence)
        const prevRamped = sim.rampedCurrent[i - 1] ?? 0;
        const isAccel = filteredDemand > prevRamped;
        const rampedCurrent = applyCurrentRamp(filteredDemand, prevRamped, rpm, settings, isAccel);
        sim.rampedCurrent.push(rampedCurrent);

        // Release duration (fade after assist ends - simplified for MVP)
        let finalCurrent = rampedCurrent;
        // TODO: implement proper fade-out over release_duration_ms

        // Apply current limit
        const currentLimitPct = settings.max_motor_current_pct || 100;
        const currentLimitNorm = currentLimitPct / 100;
        finalCurrent = Math.min(finalCurrent, currentLimitNorm);
        const limitedByI = finalCurrent === currentLimitNorm && currentLimitPct < 100 ? currentLimitNorm : null;

        sim.finalCurrent.push(finalCurrent);
        sim.cadence.push(rpm);
        sim.pedalLoad.push(pedal);
        sim.limitActive.push(limitedByI);
    }

    return sim;
}

// Check if assist can start: needs both crank movement AND minimum pedal load
function canStartAssist(pedalLoad, cadenceRpm, settings) {
    const minLoad = (settings.min_pedal_load_kg || 0) / 60; // normalized to 0–1
    const needsCrank = !(settings.assist_without_crank || false);

    if (pedalLoad < minLoad) return false;
    if (needsCrank && cadenceRpm < 5) return false;
    return true;
}

// Calculate boost fade based on cadence (FW-037/070)
export function calculateBoostFade(timeSinceStart, cadenceRpm, settings) {
    const endRpm = settings.startup_boost_end_rpm || 90;
    if (cadenceRpm > endRpm) return 0;

    // Exponential fade: (256 - cadence_step) / 256
    const cadenceStep = settings.startup_boost_cadence_step || 20;
    const fade = (256 - cadenceStep) / 256;
    return Math.pow(fade, cadenceRpm / 5);
}

// Apply power rise/fall filters. Mirrors firmware filter_motor_power()
// (assist_modes.c): every control tick moves the filtered value by
// (raw - filtered) / filter_ticks, so filter_ms IS the time constant — after one
// filter_ms interval about 63% of a step has been followed, not 100%.
//
// The old version divided a dt already expressed in SECONDS by 1000 again, making
// alpha 1000x too small: every curve it produced was a near-flat crawl that never
// left the axis, which is why the smoothing preview was unreadable.
export function applyPowerFilters(current, prevFiltered, settings, isRising, dtMs = 100) {
    const riseFilterMs = (settings.power_rise_filter_ms || 0);
    const fallFilterMs = (settings.power_fall_filter_ms || 0);
    const filterMs = isRising ? riseFilterMs : fallFilterMs;

    if (filterMs <= 0) return current;

    const alpha = Math.min(1, dtMs / filterMs);
    return prevFiltered + (current - prevFiltered) * alpha;
}

// Apply current ramp (acceleration/deceleration) based on cadence
function applyCurrentRamp(target, prevCurrent, cadenceRpm, settings, isAccel) {
    const lowRampMs = isAccel ? (settings.iq_rise_slow_ms || 600) : (settings.iq_fall_slow_ms || 1000);
    const highRampMs = isAccel ? (settings.iq_rise_fast_ms || 300) : (settings.iq_fall_fast_ms || 140);

    // Interpolate ramp time based on cadence (0–150 rpm normalized)
    const cadence01 = Math.min(1, cadenceRpm / 150);
    const rampMs = lowRampMs + (highRampMs - lowRampMs) * cadence01;

    // Ramp toward target
    const dt = 0.1; // 100ms per step
    const maxDelta = (dt / 1000) / (rampMs / 1000);
    const delta = target - prevCurrent;

    if (delta > 0) return Math.min(target, prevCurrent + Math.abs(delta) * maxDelta);
    return Math.max(target, prevCurrent + delta * maxDelta);
}

// Generate scenario data (pedal load, cadence, base aid over time)
function generateScenario(scenarioName, length) {
    const time = Array.from({ length }, (_, i) => (i * 0.1));
    const data = {
        pedalLoad: new Array(length).fill(0),
        cadence: new Array(length).fill(0),
        baseAid: new Array(length).fill(0),
    };

    const t10s = 100; // 10 seconds

    switch (scenarioName) {
        case 'start_from_stand':
            // 0–2s: ramp pedal load and cadence from 0, aid ramps up
            for (let i = 0; i < t10s; i++) {
                const phase = i / 20; // 0–5 at 1s
                if (i < 20) {
                    data.pedalLoad[i] = Math.min(0.5, phase * 0.25); // 0–50% load over 2s
                    data.cadence[i] = Math.min(60, phase * 30); // 0–60 rpm over 2s
                    data.baseAid[i] = Math.min(0.8, phase * 0.4); // 0–80% aid
                } else if (i < 50) {
                    // Hold steady
                    data.pedalLoad[i] = 0.4;
                    data.cadence[i] = 80;
                    data.baseAid[i] = 0.7;
                } else {
                    // Release pedals
                    data.pedalLoad[i] = 0;
                    data.cadence[i] = 0;
                    data.baseAid[i] = 0;
                }
            }
            break;

        case 'smooth_ride':
            for (let i = 0; i < t10s; i++) {
                data.pedalLoad[i] = 0.3 + 0.1 * Math.sin(i / 20);
                data.cadence[i] = 90 + 10 * Math.sin(i / 15);
                data.baseAid[i] = 0.4;
            }
            break;

        case 'hard_accel':
            for (let i = 0; i < t10s; i++) {
                if (i < 10) {
                    data.pedalLoad[i] = i / 10 * 0.8;
                    data.cadence[i] = i / 10 * 100;
                    data.baseAid[i] = i / 10 * 0.9;
                } else if (i < 50) {
                    data.pedalLoad[i] = 0.8;
                    data.cadence[i] = 100;
                    data.baseAid[i] = 0.9;
                } else {
                    data.pedalLoad[i] = 0;
                    data.cadence[i] = 0;
                    data.baseAid[i] = 0;
                }
            }
            break;

        case 'hill':
            for (let i = 0; i < t10s; i++) {
                data.pedalLoad[i] = 0.6;
                data.cadence[i] = 60;
                data.baseAid[i] = 0.8;
            }
            break;

        case 'release':
            for (let i = 0; i < t10s; i++) {
                if (i < 30) {
                    data.pedalLoad[i] = 0.4;
                    data.cadence[i] = 90;
                    data.baseAid[i] = 0.6;
                } else if (i < 40) {
                    data.pedalLoad[i] = 0;
                    data.cadence[i] = 0;
                    data.baseAid[i] = 0;
                } else {
                    data.pedalLoad[i] = 0;
                    data.cadence[i] = 0;
                    data.baseAid[i] = 0;
                }
            }
            break;

        default:
            // Default: start from stand + release
            return generateScenario('start_from_stand', length);
    }

    return data;
}
