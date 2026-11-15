const assert = require('node:assert/strict');
const fs = require('node:fs');
const { zipStore, crc32 } = require('../ui/webusb/zip-store');

async function main() {
    // The published check value of CRC-32.
    assert.equal(await crc32(new Blob(['123456789'])), 0xCBF43926);

    // Larger than one read slice, so the CRC has to carry across slices.
    const big = new Uint8Array(9 * 1024 * 1024).map((_, i) => (i * 31) & 0xFF);
    const files = [
        { name: 'can-trace-p001.log', blob: new Blob([big]) },
        { name: 'console.log', blob: new Blob(['line\n']) },
        { name: 'empty.log', blob: new Blob([]) },
    ];
    const zip = await zipStore(files, new Date(2026, 10, 6, 22, 30, 10));
    const bytes = Buffer.from(await zip.arrayBuffer());
    assert.equal(bytes.readUInt32LE(0), 0x04034B50);
    const end = bytes.length - 22;
    assert.equal(bytes.readUInt32LE(end), 0x06054B50);
    assert.equal(bytes.readUInt16LE(end + 10), 3);

    await assert.rejects(zipStore([{ name: 'x', blob: { size: 0x100000000 } }]), /too large/);

    if (process.argv[2]) fs.writeFileSync(process.argv[2], bytes); // for a check with another zip tool
    console.log('Zip store tests passed');
}
main().catch((error) => { console.error(error); process.exit(1); });
