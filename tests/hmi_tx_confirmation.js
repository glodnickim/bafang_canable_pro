const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const FwUpdater = require('../fw-updater');

async function schedulingRegression() {
    const callbacks = [];
    let clock = 0n;
    let priority = 7;
    let denyRaise = false;
    const changes = [];
    const fakeOs = {
        constants: { priority: { PRIORITY_HIGH: -14 } },
        getPriority: () => priority,
        setPriority: value => {
            if (denyRaise && value === -14) throw new Error('access denied');
            changes.push(value);
            priority = value;
        },
    };
    const context = {
        module: { exports: {} }, Buffer, console, performance,
        process: { env: {}, hrtime: { bigint: () => clock } },
        setImmediate: fn => callbacks.push(fn),
        setTimeout: () => { throw new Error('echo wait must not use coarse timers'); },
        clearTimeout: () => {},
        require: name => name === 'node:os' ? fakeOs : name === './utils'
            ? { setupLogger: async () => Object.assign(() => {}, { close: async () => {} }) }
            : require(name),
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../fw-updater'), 'utf8'), context);
    const Updater = context.module.exports;
    const makeUpdater = () => {
        const updater = new Updater(new EventEmitter());
        updater.logMessage = () => {};
        updater.dumpFrameTrace = () => {};
        updater.preflightAdapter = async () => ({ ok: true });
        return updater;
    };
    const updater = makeUpdater();
    let resolved = false;
    const timeout = updater.waitForEcho().then(result => { resolved = true; return result; });
    clock = 4999999n;
    callbacks.shift()();
    await Promise.resolve();
    assert.equal(resolved, false, 'deadline must not expire early');
    clock = 5000000n;
    callbacks.shift()();
    assert.equal(await timeout, true);
    assert.equal(updater.echoWaiter, null);
    const echoed = updater.waitForEcho();
    updater.echoWaiter();
    assert.equal(await echoed, false, 'echo releases the wait before its deadline');
    callbacks.shift()();
    assert.equal(callbacks.length, 0, 'completed echo poll must stop rescheduling');
    updater.cleanup();

    for (const fail of [false, true]) {
        changes.length = 0;
        const attempt = makeUpdater();
        attempt.runUpdateAttempt = async () => {
            assert.equal(priority, -14, 'HIGH must cover the actual update');
            if (fail) throw new Error('simulated flash failure');
        };
        assert.equal(await attempt.startUpdateProcedure(Buffer.alloc(0)), !fail);
        assert.deepEqual(changes, [-14, 7]);
        assert.equal(priority, 7, 'restore the original priority on success and failure');
        assert.equal(attempt.canbus.listenerCount('raw_frame_sent'), 0);
    }
    denyRaise = true;
    changes.length = 0;
    const denied = makeUpdater();
    denied.runUpdateAttempt = async () => assert.equal(priority, 7);
    assert.equal(await denied.startUpdateProcedure(Buffer.alloc(0)), true);
    assert.deepEqual(changes, [], 'permission failure must allow update without changing priority');
    const preflight = makeUpdater();
    preflight.preflightAdapter = async () => ({ ok: false, reason: 'disconnected' });
    preflight.runUpdateAttempt = async () => assert.fail('preflight must prevent transmission');
    assert.equal(await preflight.startUpdateProcedure(Buffer.alloc(0)), false);
    assert.deepEqual(changes, []);
}

async function main() {
    await schedulingRegression();
    const bus = new EventEmitter();
    bus.isConnected = () => true;
    const updater = new FwUpdater(bus);
    updater.logMessage = () => {};
    updater.setupForHMI();
    updater.chunkEchoTimeoutMs = 30;
    const echo = id => bus.emit('raw_frame_sent', { can_id: parseInt(id, 16) });
    try {
        let release;
        bus.sendRawFrame = async () => {
            echo('85FF3005'); // unrelated host traffic must not release a chunk
            echo('851D0001'); // nor a late echo of the previous chunk
            release = () => echo('851D0002');
            return true;
        };
        let finished = false;
        const send = updater.sendRawFrameWithRetry('51D0002', '1234').then(() => { finished = true; });
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(finished, false);
        release();
        await send;
        assert.equal(updater.chunkEchoPending, null);

        // Echo may arrive before the USB write promise completes.
        bus.sendRawFrame = async id => { echo(id); return true; };
        await updater.sendRawFrameWithRetry('51C0000', '1234');
        await updater.sendRawFrameWithRetry('51E0003', '1234');

        let sends = 0;
        bus.sendRawFrame = async () => { sends++; return true; };
        await assert.rejects(updater.sendRawFrameWithRetry('51D0003', '1234'), /No CAN transmit confirmation/);
        assert.equal(sends, 1, 'missing echo must not retransmit an ambiguous chunk');
        assert.equal(updater.chunkEchoPending, null);
        await updater.sendRawFrameWithRetry('5196008', ''); // commands use device ACKs

        updater.init();
        updater.setupForNewMotor();
        await updater.sendRawFrameWithRetry('5150002', '1234');
        assert.equal(updater.strictChunkEcho, false);
        for (let i = 0; i < 800; i++) {
            updater.recordFrameTrace('RX', {
                can_id: 0x832A0002, can_dlc: 0,
                data: new DataView(new ArrayBuffer(8)), timestamp_us: BigInt(i),
            });
        }
        const trace = [];
        updater.logMessage = (message, type) => { if (type === 'TRACE') trace.push(message); };
        updater.dumpFrameTrace();
        assert.equal(trace.length, 768);
        assert.match(trace[0], /adapter_us=32 /);
        assert.match(trace[767], /adapter_us=799 /);
    } finally {
        updater.cleanup();
    }
    assert.equal(bus.listenerCount('raw_frame_sent'), 0);
    console.log('HMI transmit confirmation tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
