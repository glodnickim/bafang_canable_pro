// readBankAndWait (common.js): the save path's bank readback must be bound to its own READ_BANK.
// An answer received before the request was sent never counts as confirmation, even when its
// thresholds match what was sent; an answer received after the send does, and the newest answer
// within the settle window wins. Loads the real common.js with shared.js stubbed.
const path = require('path');
const { pathToFileURL } = require('url');
const mod = require('module');

let failures = 0;
function check(name, ok, detail = '') {
    if (ok) console.log(`  PASS ${name}`);
    else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}

global.__bankState = {};
global.__bankSocket = { readyState: 1, sent: [], onSend: null, send(text) { this.sent.push(text); if (this.onSend) this.onSend(text); } };
const shared = `export const state = globalThis.__bankState; export const socket = globalThis.__bankSocket;
    export function addLog() {} export const torqueMvToKg = (v) => v; export function helpBadge() { return null; }`;
mod.registerHooks({
    resolve(specifier, context, next) {
        if (specifier === '../shared.js' && context.parentURL?.endsWith('common.js')) {
            return { url: `data:text/javascript,${encodeURIComponent(shared)}`, shortCircuit: true };
        }
        return next(specifier, context);
    },
});

(async () => {
    const C = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'common.js')).href);
    const S = global.__bankState;
    const sock = global.__bankSocket;
    const bank = (kg) => ({ bank_index: 0, levels: [{ minimum_pedal_load_kg: kg }] });
    // What websocket.js does on a controller_bank answer.
    const receive = (b) => { S.lastBanks = S.lastBanks || {}; S.lastBanks[0] = b; S.bankRxSeq = S.bankRxSeq || {}; S.bankRxSeq[0] = (S.bankRxSeq[0] || 0) + 1; };

    // A stale answer (matching the sent thresholds) arrived BEFORE the request; nothing after it.
    receive(bank(5));
    sock.onSend = null;
    const stale = await C.readBankAndWait(0, 200, 0);
    check('stale earlier answer is not a confirmation', stale.ok === false && sock.sent.at(-1) === 'READ_BANK:0', JSON.stringify(stale));

    // An answer after the send counts.
    sock.onSend = () => setTimeout(() => receive(bank(5)), 30);
    const fresh = await C.readBankAndWait(0, 500, 0);
    check('answer after the send confirms', fresh.ok === true && S.lastBanks[0].levels[0].minimum_pedal_load_kg === 5, JSON.stringify(fresh));

    // An older request still in flight answers first (old values), ours second: the newest wins.
    sock.onSend = () => { setTimeout(() => receive(bank(5)), 20); setTimeout(() => receive(bank(4)), 60); };
    const twice = await C.readBankAndWait(0, 500, 150);
    check('two answers after the send: the newest is the one compared', twice.ok === true && S.lastBanks[0].levels[0].minimum_pedal_load_kg === 4);

    // A read error after the send fails; an error from before does not.
    S.bankReadErrorSeq = 3; S.ebicsBankReadError = 'old';
    sock.onSend = () => setTimeout(() => { S.ebicsBankReadError = 'crc'; S.bankReadErrorSeq += 1; }, 20);
    const err = await C.readBankAndWait(0, 500, 0);
    check('read error after the send reported', err.ok === false && err.reason === 'crc', JSON.stringify(err));
    sock.onSend = null;

    // websocket.js counts the answers and the errors.
    const ws = require('fs').readFileSync(path.join(__dirname, '..', 'ui', 'js', 'websocket.js'), 'utf8');
    check('websocket.js counts bank answers and read errors', /state\.bankRxSeq\[parsedEvent\.data\.bank_index\] =/.test(ws) && /state\.bankReadErrorSeq = /.test(ws));

    if (failures) { console.error(`bank_readback_fresh: ${failures} failure(s)`); process.exit(1); }
    console.log('bank_readback_fresh: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
