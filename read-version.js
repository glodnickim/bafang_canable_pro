// Read the controller software version (0x6001) directly via CAN, print it.
const canbus = require('./canbus');
async function main(){
  const ok = await canbus.init();
  if(!ok){ console.log('BRAK POLACZENIA'); process.exit(1); }
  await new Promise(r=>setTimeout(r,800));
  const target = 2; // DRIVE_UNIT
  for (const [name, sub] of [['sw_version',1],['serial(0x6001)',3]]) {
    try {
      const res = await canbus.readParameter(target, {canCommandCode:96, canCommandSubCode:sub, applicableDevices:[target]});
      console.log(name, '=>', JSON.stringify(res));
    } catch(e){ console.log(name, 'ERROR', e.message); }
  }
  try { await canbus.close(); } catch { /* already exiting; a failed close changes nothing */ }
  process.exit(0);
}
main();
