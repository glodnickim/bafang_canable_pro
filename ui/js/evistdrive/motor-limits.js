// evistdrive/motor-limits.js — CB-024: what the two ceiling settings mean in units a rider
// can feel, and the envelope they produce together.
//
// Pure arithmetic, no DOM, no app state, no imports. That is deliberate: it is the only way
// the numbers on the chart and the numbers in the field can be tested for real instead of
// re-derived in a test that agrees with itself.
//
// WHAT IS AND IS NOT KNOWN
//
// max_iq_pct is a percentage of the CONTROLLER's phase-current limit, not of the motor's
// rated torque. Torque is very nearly proportional to current in a PMSM, so scaling linearly
// is sound — but "100% = 80 Nm" only holds if the controller's phase-current limit is the
// current at which an M820 actually makes its rated 80 Nm. Set the controller's limit lower
// and 100% is less than 80 Nm. Everything here is therefore an ESTIMATE and is labelled as
// one in the UI. There is no dyno run and no manufacturer map behind these numbers.
//
// For the same reason nothing here invents a torque curve: no artificial boost below 50 rpm,
// no roll-off at high cadence. The chart draws the two ceilings the settings impose and where
// they cross. That crossing is real — it comes from P = M x omega, not from a guess.

export const M820_MAX_TORQUE_NM = 80;
// Drivetrain + motor efficiency used only to convert between the electrical watts the
// firmware limits and the mechanical watts a torque figure implies. 0.80 is a conservative
// mid-drive figure; it is a preview constant, not a measurement.
export const PREVIEW_EFFICIENCY = 0.80;
export const MAX_PREVIEW_CADENCE_RPM = 120;

const IQ_PCT_MIN = 0;
const IQ_PCT_MAX = 100;

/* Every entry point takes whatever the caller has — a missing field, a string, NaN from an
 * empty input box — and turns it into a number the arithmetic below cannot trip over. */
function finiteOr(value, fallback) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clampNumber(value, low, high) {
    if (value < low) return low;
    if (value > high) return high;
    return value;
}

export function iqPercentToTorqueNm(iqPercent, maxTorqueNm = M820_MAX_TORQUE_NM) {
    const ceiling = Math.max(0, finiteOr(maxTorqueNm, M820_MAX_TORQUE_NM));
    const percent = clampNumber(finiteOr(iqPercent, 0), IQ_PCT_MIN, IQ_PCT_MAX);
    return (ceiling * percent) / 100;
}

export function torqueNmToIqPercent(torqueNm, maxTorqueNm = M820_MAX_TORQUE_NM) {
    const ceiling = Math.max(0, finiteOr(maxTorqueNm, M820_MAX_TORQUE_NM));
    if (ceiling <= 0) return 0;
    const torque = clampNumber(finiteOr(torqueNm, 0), 0, ceiling);
    // Rounded, because the controller stores whole percent. The rider sees the Nm they asked
    // for snap to what can actually be stored, exactly like the kg fields do.
    return clampNumber(Math.round((torque / ceiling) * 100), IQ_PCT_MIN, IQ_PCT_MAX);
}

/*
 * One point on the limit envelope.
 *
 * activeLimiter answers "which setting is holding the motor back HERE":
 *   "power"   — the power ceiling bites first at this cadence
 *   "current" — the current ceiling is the one being felt
 *   "none"    — neither restricts: full phase current allowed and no power ceiling set
 *
 * At 0 rpm there is no mechanical power however much torque is available (P = M x omega),
 * so the power ceiling cannot be expressed as a torque at all. The division is skipped
 * rather than guarded after the fact, and powerTorqueLimitNm is reported as null so a caller
 * cannot mistake a sentinel number for a real limit.
 */
export function calculateMotorLimitPoint(options = {}) {
    const {
        cadenceRpm,
        maxIqPct,
        maxMotorPowerW,
        maxTorqueNm = M820_MAX_TORQUE_NM,
        efficiency = PREVIEW_EFFICIENCY,
    } = options;

    const cadence = Math.max(0, finiteOr(cadenceRpm, 0));
    const iqPct = clampNumber(finiteOr(maxIqPct, 0), IQ_PCT_MIN, IQ_PCT_MAX);
    const powerLimitW = Math.max(0, finiteOr(maxMotorPowerW, 0));
    const torqueCeiling = Math.max(0, finiteOr(maxTorqueNm, M820_MAX_TORQUE_NM));
    // A zero or nonsense efficiency would divide the electrical figure into infinity.
    const eta = clampNumber(finiteOr(efficiency, PREVIEW_EFFICIENCY), 0.01, 1);

    const currentTorqueLimitNm = iqPercentToTorqueNm(iqPct, torqueCeiling);
    const omega = (cadence * 2 * Math.PI) / 60;

    let powerTorqueLimitNm = null;
    if (powerLimitW > 0 && omega > 0) {
        powerTorqueLimitNm = (powerLimitW * eta) / omega;
    }

    const availableTorqueNm = powerTorqueLimitNm === null
        ? currentTorqueLimitNm
        : Math.min(currentTorqueLimitNm, powerTorqueLimitNm);

    const mechanicalPowerW = availableTorqueNm * omega;
    let electricalPowerW = mechanicalPowerW / eta;
    if (powerLimitW > 0) {
        electricalPowerW = Math.min(electricalPowerW, powerLimitW);
    }

    let activeLimiter;
    if (powerTorqueLimitNm !== null && powerTorqueLimitNm < currentTorqueLimitNm) {
        activeLimiter = 'power';
    } else if (iqPct < IQ_PCT_MAX || powerLimitW > 0) {
        activeLimiter = 'current';
    } else {
        activeLimiter = 'none';
    }

    return {
        cadenceRpm: cadence,
        currentTorqueLimitNm,
        powerTorqueLimitNm,
        availableTorqueNm,
        mechanicalPowerW,
        electricalPowerW,
        activeLimiter,
    };
}

/*
 * The whole envelope, ready for a chart: parallel arrays plus the points themselves.
 *
 * The cadence at which the two ceilings cross is reported separately — it is the one number
 * on the chart a rider can act on ("above this cadence the power setting is what you feel"),
 * and finding it by eye from a plotted line is exactly the kind of thing a UI should do for
 * them.
 */
export function buildMotorLimitSeries(options = {}) {
    const {
        maxIqPct,
        maxMotorPowerW,
        maxCadenceRpm = MAX_PREVIEW_CADENCE_RPM,
        stepRpm = 2,
        maxTorqueNm = M820_MAX_TORQUE_NM,
        efficiency = PREVIEW_EFFICIENCY,
    } = options;

    const topCadence = Math.max(1, finiteOr(maxCadenceRpm, MAX_PREVIEW_CADENCE_RPM));
    const step = clampNumber(finiteOr(stepRpm, 2), 0.5, topCadence);

    const points = [];
    for (let cadence = 0; cadence <= topCadence + 1e-9; cadence += step) {
        points.push(calculateMotorLimitPoint({
            cadenceRpm: Math.min(cadence, topCadence),
            maxIqPct,
            maxMotorPowerW,
            maxTorqueNm,
            efficiency,
        }));
    }

    let crossoverRpm = null;
    for (let i = 1; i < points.length; i++) {
        if (points[i - 1].activeLimiter !== 'power' && points[i].activeLimiter === 'power') {
            crossoverRpm = points[i].cadenceRpm;
            break;
        }
    }

    return {
        points,
        cadenceRpm: points.map((point) => point.cadenceRpm),
        currentTorqueLimitNm: points.map((point) => point.currentTorqueLimitNm),
        availableTorqueNm: points.map((point) => point.availableTorqueNm),
        electricalPowerW: points.map((point) => point.electricalPowerW),
        mechanicalPowerW: points.map((point) => point.mechanicalPowerW),
        crossoverRpm,
    };
}
