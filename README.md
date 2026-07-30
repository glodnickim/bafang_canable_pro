# Bafang Besst software replacement for M500, M510, M560, M820 etc  
![GUI](Screenshot.jpg)
# Steps to run the software

## Get hardware 
 - Canable with STM32F072 or STM32G431 processor and candlelight firmware ([Ebay](https://www.ebay.com/itm/156316405598),[Aliexpress](https://pl.aliexpress.com/item/1005006029234562.html))
 - 5 pin Cable with male and famale plugs ([Ebay](https://www.ebay.com/itm/197421023105),[Aliexpress](https://pl.aliexpress.com/item/1005005307670708.html))

## Wire the Canable (UCAN module example)
![GUI](UCAN_wiring.JPG)

## Run the software from executable
- Download and run last [release](https://github.com/mdi-9/bafang_canable_pro/releases)
- Open [localhost:8080](http://localhost:8080)

## Or run the software from source code
- Install nodeJS and npm
- Download source code for last [release](https://github.com/mdi-9/bafang_canable_pro/releases)
- Unzip and open folder in terminal
- Run `npm install` in terminal to download all dependencies
- Run `node server.js` in terminal

## eVistDrive Ride Core interface

The source build adds a second set of tabs for controllers running eVistDrive Ride Core
firmware. They appear only once that firmware is detected, and every factory Bafang tab
keeps working unchanged against a stock controller. Implementation status and the hardware
test procedure: [documentation/EBICS_PARALLEL_UI_IMPLEMENTATION_PL.md](documentation/EBICS_PARALLEL_UI_IMPLEMENTATION_PL.md).

**Where the new code lives.** Everything eVistDrive is under `ui/js/evistdrive/`, one
module per card, and the folder boundary is also the dependency rule — it imports from
`ui/js/shared.js`, never the other way round:

| File | Card |
|---|---|
| `evistdrive/index.js` | entry point: which card refreshes on which CAN frame |
| `evistdrive/common.js` | selectors, field builder, shared chart styling |
| `evistdrive/live.js` | Live |
| `evistdrive/profiles.js` | Profiles — level editor and preview charts |
| `evistdrive/torque.js` | Torque — kg, calibration, coast re-zero |
| `evistdrive/dynamics.js` | Dynamics — global ride-feel tuning |
| `evistdrive/limits.js` | Limits — live draw vs ceilings, full-charge voltage |
| `evistdrive/walk.js` | Walk + legacy cross-reference |
| `evistdrive/system.js` | System — ride-core diagnostics |
| `evistdrive/legacy-params.js` | fields still stored in legacy CAN blocks |
| `evistdrive/detection.js` | controller family detection |

Files directly in `ui/js/` (`tab-controller.js`, `tab-battery.js`, `tab-gears*.js`, …) are
the factory Bafang tabs. New features go into `ui/js/evistdrive/`, never into those.

On the wire the new blobs are versioned, and `bafang-parser.js` decodes each version it
knows: bank `0x6020` v1–v5, tuning `0x6023` v1–v5, diagnostics `0x6029` v1–v4, torque
telemetry `0x6025` v1–v2, system status `0x6028` v1–v2. A field the connected controller
is too old to send is reported as `null`, never as `0`, so the UI can show "unavailable"
instead of a zero that reads like a real measurement.

### Development

```bash
npm run dev      # run from source on http://localhost:8080
npm run lint     # eslint (vendored plotly/tailwind bundles excluded)
npm test         # bank blob serialise/parse round trip
npm run build:win  # single-file .exe in dist/ — see BUILD_EXE.md
```

## (STM32G431) Required: candlelight firmware flashing 
- For Canable 2.0 (STM32G431) use [HUD ECU Hacker candlelight firmware and updater](https://www.netcult.ch/elmue/CANable%20Firmware%20Update/)

## (STM32F072) Optional: candlelight firmware flashing (in case of wrong module firmware or drivers issues)
- For (STM32F072) download last version of [candlelight firmware](https://github.com/candle-usb/candleLight_fw/releases)
- And flash dowloaded firmware to the Canable device with one of [this tool](https://canable.io/getting-started.html#flashing-new-firmware)
or use [HUD ECU Hacker updater](https://www.netcult.ch/elmue/CANable%20Firmware%20Update/)

### License
This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
