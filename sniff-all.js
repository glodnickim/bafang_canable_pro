// Quick all-frame sniff: list unique CAN IDs seen in 6s, and whether 0x00010203 is present.
const canbus = require('./canbus');
const { formatRawCanFrameData2 } = require('./utils');
const seen = {};
let total = 0;
function onRaw(f){
  const { idHex } = formatRawCanFrameData2(f);
  if(idHex==='INVALID') return;
  total++;
  seen[idHex] = (seen[idHex]||0)+1;
}
async function main(){
  const ok = await canbus.init();
  if(!ok){ console.log('BRAK POLACZENIA Z CANABLE'); process.exit(1); }
  canbus.on('raw_frame_received', onRaw);
  setTimeout(async ()=>{
    console.log('=== ramek lacznie:', total, '===');
    for(const id of Object.keys(seen).sort()) console.log(id, ':', seen[id]);
    console.log('=== czy jest debug 00010203:', Object.keys(seen).some(x=>x.includes('10203')) ? 'TAK' : 'NIE', '===');
    try { await canbus.close(); } catch { /* already exiting; a failed close changes nothing */ }
    process.exit(0);
  }, 6000);
}
main();
