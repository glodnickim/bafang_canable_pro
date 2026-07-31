// CB-019 host test: the help bubble must state factory default and allowed range,
// formatted the way the field is shown (not in raw native units).
'use strict';
let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };

// Mirrors the detail assembly in evistdrive/common.js fieldInput().
function tooltipDetails(descriptor) {
    const details = [descriptor.help];
    if (Object.prototype.hasOwnProperty.call(descriptor, 'factoryDefault')) {
        const fromNative = descriptor.fromNative || ((v) => v);
        const raw = descriptor.factoryDefault;
        const shown = descriptor.type === 'checkbox' ? (raw ? 'On' : 'Off') : fromNative(raw);
        const suffix = descriptor.type === 'checkbox' || !descriptor.unit ? '' : ` ${descriptor.unit}`;
        details.push(`${descriptor.factoryDefaultLabel || 'Factory default'}: ${shown}${suffix}.`);
    }
    if (descriptor.type !== 'checkbox'
        && Number.isFinite(descriptor.min) && Number.isFinite(descriptor.max)) {
        const suffix = descriptor.unit ? ` ${descriptor.unit}` : '';
        details.push(`Allowed range: ${descriptor.min}-${descriptor.max}${suffix}.`);
    }
    return details.join(' ');
}

const MV_PER_KG = 27;

// A native-unit field (mV stored, kg shown) must report BOTH numbers in kg.
const load = tooltipDetails({
    key: 'without_rotation_threshold_mv', label: 'Minimum pedal load', unit: 'kg',
    min: 0, max: 11, step: 0.1, help: 'Relative load above zero.',
    fromNative: (v) => Math.round((v / MV_PER_KG) * 10) / 10,
    factoryDefault: 18,
    factoryDefaultLabel: 'Factory default for Bank 1 / ECO',
});
check(load.includes('Factory default for Bank 1 / ECO: 0.7 kg.'),
    `native default must be shown in kg, got: ${load}`);
check(load.includes('Allowed range: 0-11 kg.'), 'range must carry the unit');
check(!load.includes('18'), 'the raw mV value must never leak into the bubble');

// A checkbox has no range and reads On/Off, not true/false.
const box = tooltipDetails({
    key: 'assist_without_rotation', label: 'Assist without crank rotation', type: 'checkbox',
    help: 'Push from a dead stop.', factoryDefault: false,
});
check(box.includes('Factory default: Off.'), `checkbox default must read Off, got: ${box}`);
check(!box.includes('Allowed range'), 'a checkbox must not advertise a numeric range');

// A plain numeric field keeps its unit on both lines.
const ms = tooltipDetails({
    key: 'release_ms', label: 'Release duration', unit: 'ms', min: 0, max: 3000, step: 50,
    help: 'Fade to zero.', factoryDefault: 650,
});
check(ms.includes('Factory default: 650 ms.'), `got: ${ms}`);
check(ms.includes('Allowed range: 0-3000 ms.'), `got: ${ms}`);

// Without a declared default there must be no invented one.
const none = tooltipDetails({ key: 'x', label: 'X', unit: 'W', min: 0, max: 10, help: 'H.' });
check(!none.includes('Factory default'), 'no default declared -> no default line');

console.log(failures === 0 ? 'CB-019 help bubble content: PASS'
    : `CB-019 help bubble content: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
