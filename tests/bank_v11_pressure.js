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
