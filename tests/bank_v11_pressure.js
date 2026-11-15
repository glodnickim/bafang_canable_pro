'use strict';
const assert = require('assert');
const { BafangCanControllerParser } = require('../bafang-parser');
const serialize = require('../canbus').constructor.serializeBankBlob;
for (const version of [9, 10, 11]) {
  const lv = {mode_type: 1, minimum_pedal_load_kg: 2.55, riding_minimum_pedal_load_kg: 1.1,
    minimum_pedal_load_clu: 70, riding_minimum_pedal_load_clu: 30};
  const bytes = serialize({bank_schema_version: version, bank_index: 0, levels: Array(5).fill(lv)});
  assert.strictEqual(bytes[2], version);
  assert.strictEqual(bytes[32] | bytes[33] << 8, version === 11 ? 255 : 70);
  assert.strictEqual(bytes[48], version === 11 ? 11 : 3);
  const parsed = BafangCanControllerParser.bankBlob({data: bytes});
  assert.ok(!parsed.parseError);
  if (version === 11) {
    assert.strictEqual(parsed.levels[0].minimum_pedal_load_kg, 2.55);
    assert.strictEqual(parsed.levels[0].riding_minimum_pedal_load_kg, 1.1);
  } else {
    assert.strictEqual(parsed.levels[0].minimum_pedal_load_kg, undefined);
    assert.strictEqual(parsed.levels[0].minimum_pedal_load_clu, 70);
    assert.strictEqual(parsed.levels[0].riding_minimum_pedal_load_clu, 30);
    assert.deepStrictEqual(serialize(parsed).slice(32, 34), bytes.slice(32, 34));
    assert.strictEqual(serialize(parsed)[48], 3);
  }
}
console.log('Bank v9-v11 pressure units: PASS');

// Captured from assist_modes_init()/assist_modes_serialize_bank(), firmware v11.
const firmware = Array.from(Buffer.from(require('fs').readFileSync(require('path').join(__dirname, 'fixtures/bank_v11_firmware.hex'), 'ascii').trim(), 'hex'));
const parsedFirmware = BafangCanControllerParser.bankBlob({data: firmware});
assert.ok(!parsedFirmware.parseError);
assert.deepStrictEqual(serialize(parsedFirmware), firmware, 'firmware blob including CRC survives unchanged');
parsedFirmware.levels[0].minimum_pedal_load_kg = 3.21;
parsedFirmware.levels[0].riding_minimum_pedal_load_kg = 1.2;
const edited = serialize(parsedFirmware);
for (let i = 0; i < 253; i++) {
  if (![32, 33, 48].includes(i)) assert.strictEqual(edited[i], firmware[i], `unexpected change at ${i}`);
}
let crc = 0xffff;
for (const byte of edited.slice(0, 253)) {
  crc ^= byte << 8;
  for (let bit = 0; bit < 8; bit++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
}
assert.strictEqual(edited[253] | edited[254] << 8, crc);
console.log('Firmware v11 bit-exact roundtrip and edited CRC: PASS');
