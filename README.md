# Bafang Besst software replacement for M500, M510, M560, M820 etc  
![GUI](Screenshot.jpg)
# Steps to run the software

## Get hardware 
 - Canable with STM32F072 or STM32G431 processor and candlelight firmware ([Ebay](https://www.ebay.com/itm/156316405598),[Aliexpress](https://pl.aliexpress.com/item/1005006029234562.html))
 - 5 pin Cable with male and famale plugs ([Ebay](https://www.ebay.com/itm/197421023105),[Aliexpress](https://pl.aliexpress.com/item/1005005307670708.html))

## v1.0.29

- Nowe pole „eVistDrive — kąt niskich obrotów” (wł./wył.) w ustawieniach rowerzysty (widok zaawansowany). Nowy sposób liczenia kąta przy ruszaniu; wył. = jak 0.709. Wymaga firmware z bitem możliwości 15; na starszym firmware pole jest wyszarzone i nie jest zapisywane. Zapis przez „Zapisz na rowerze” z odczytem kontrolnym; zapisana wartość to żądanie — sterownik włącza ją dopiero na postoju.

## v1.0.28

- Dopych: zakres czasu i drogi zależny od możliwości firmware; nazwa ustawienia Asysta.

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

## Or run it in the browser, no install

The same app runs in the browser and talks to the CANable over WebUSB: Chrome or Edge on
Windows, Linux, macOS or Android (with a USB OTG cable). iPhone and Firefox have no WebUSB.
It is published from the `evistdrive` branch at
[glodnickim.github.io/bafang_canable_pro](https://glodnickim.github.io/bafang_canable_pro/).
After the first visit it opens without internet and can be installed from the browser menu.

**Logging a whole ride:** press **Ride log**. The page reloads, the adapter only listens
(nothing is sent on the bus) and every CAN frame is saved on the device, with no filtering,
until you press **Stop**. Keep the page on screen; it keeps the screen on, and a red bar
means frames stopped or storage failed. After **Stop** the page opens **Logs**: **Save all**
gives the whole session as one `.zip` file, or save and share single files. A file is split
every 32 MB (`can-trace-p001.log`, `-p002`, ...).
If the adapter drops off USB during the ride (on Android it then has to be picked again),
the bar says **ADAPTER DISCONNECTED** with a **Reconnect** button: press it, pick the adapter,
and recording continues in the same files. `can-trace` marks the gap with
`# ... adapter disconnected` / `connected` lines.

Technically: `ui/webusb/` runs `server.js` in a worker; logs go to the browser's Origin
Private File System about once a second. `can-trace` IDs are 29-bit, without the leading 8
that the sniffer log shows. `CAN_LISTEN_ONLY=1 node server.js` gives the same silent mode
in the Node build. Firmware updates from the browser are not tested on our hardware yet.

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
npm run dev        # run from source on http://localhost:8080
npm run lint       # eslint
npm test           # bank blob serialise/parse round trip
npm run build:css  # regenerate ui/tailwind.built.css — see the trap below
npm run build:win  # single-file .exe in dist/ — see BUILD_EXE.md
```

**Three things that will bite you if nobody wrote them down.**

*Adding a Tailwind class means rebuilding the CSS.* The page no longer carries the
in-browser Tailwind compiler — it rebuilt every rule on any DOM change, and telemetry
rewrites ~20 fields per CAN frame, which is what made the UI stutter. `ui/tailwind.built.css`
is generated by `npm run build:css` and **is committed**, so running from source needs no
build step. But a utility class the generator never saw produces no rule at all, and the
element silently gets no styling. Classes of our own (`.btn-save`, `.ebics-field`, …) live
in `ui/style.css` and need no rebuild.

*A new button that writes to the controller needs `data-requires-link`.* That attribute is
what disables it while the adapter is not reachable and attaches the "?" explaining why.
Without it the button stays clickable with no link and the write goes nowhere, quietly.

*Charts should not draw while their card is hidden.* Use `tabIsVisible('tab-ebics-…')`
from `evistdrive/common.js` before calling Plotly, as every eVistDrive card now does.

*Editing must not write into the values as read.* `state.lastBanksAsRead` and
`state.lastTuningAsRead` are untouched copies kept at read time, and they are what Restore
and Shift+click go back to. A new editable card should keep the same separation, or there
will again be nothing to return to.

Background on the recent changes:
[CB-010](documentation/CB-010_ZDROWIE_LACZA_CANABLE_PL.md) (adapter link health,
auto-recovery, the pre-flash gate),
[CB-011](documentation/CB-011_WYDAJNOSC_UI_PL.md) (UI performance and a code review pass),
[CB-012/013/014](documentation/CB-012_014_PRZYWRACANIE_DYMKI_INFO_PL.md) (restoring
settings, help bubbles at the page edges, device identification).

## (STM32G431) Required: candlelight firmware flashing 
- For Canable 2.0 (STM32G431) use [HUD ECU Hacker candlelight firmware and updater](https://www.netcult.ch/elmue/CANable%20Firmware%20Update/)

## (STM32F072) Optional: candlelight firmware flashing (in case of wrong module firmware or drivers issues)
- For (STM32F072) download last version of [candlelight firmware](https://github.com/candle-usb/candleLight_fw/releases)
- And flash dowloaded firmware to the Canable device with one of [this tool](https://canable.io/getting-started.html#flashing-new-firmware)
or use [HUD ECU Hacker updater](https://www.netcult.ch/elmue/CANable%20Firmware%20Update/)

### License
This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

### 1.0.10 — Tryby V3 i progi nacisku (firmware 0.705 DIAG lub nowszy)
Panel **Tryby V3**: tryb i korekty dla każdego poziomu, sekcja **Rowerzysta i sprzęt** (model podtrzymania: minimum Iq przy niskiej i wysokiej kadencji, czas bez nacisku) oraz **Progi nacisku (kg)**: start z miejsca i start w czasie jazdy. Z firmware v11 banku wartości są prawdziwymi kg; przy starszym firmware panel pokazuje je jako jednostki wewnętrzne, z ostrzeżeniem. Działa także w wersji przeglądarkowej (WebUSB).

### 1.0.11 — eVistDrive Profiles
Zakładka **eVistDrive Profiles** (dawniej „Tryby V3”): widok **Prosty** (poziomy na górze, kolorowe tryby, trzy duże suwaki: Asysta, Moc maks., Kop na starcie; jedna para progów nacisku dla wszystkich poziomów) i **Zaawansowany** (wszystkie ustawienia, model podtrzymania, wykresy, narzędzia). Opisy raz, w legendzie i pod „?”. Podgląd mocy fabrycznej liczony jak w firmware: procent mocy baterii.

### 1.0.12 — zakładki eVistDrive po audycie
Live: „Profil (poziom HMI)”, poprawione opisy temperatury, przebiegu, prądu i mocy. System: diagnostyka v9 mapowana poprawnie, brakujące pola jako „brak w tym firmware”. Torque/System: czytelna informacja, gdy wsad NORMAL nie wysyła diagnostyki; kalibracja tylko po aktualnym odczycie. Ustawienia, które nie działają w torze V3 (kierunek, przełożenie, manetka), ukryte.

### 1.0.13 — wizualizacje w profilach
Każda karta poziomu ma trzy miniwykresy: Asysta, Moc (ustawiona moc na tle mocy baterii, kreska = domyślna trybu) i Kop (dodatkowy prąd przy ruszaniu 0–4 s, wygaszany z kadencją). Odświeżają się przy ruchu suwaka.

### 1.0.14 — jeden wykres na poziom
Asysta, Moc maks. (pozioma linia limitu „W”, ucięta część krzywej blada) i Kop na starcie (żółta przerywana nakładka) na jednym wykresie w karcie poziomu; oś X = nacisk na pedał, ta sama skala dla wszystkich poziomów.

### 1.0.15 — prawdziwy zakres mocy
Suwak Moc maks. sięga mocy baterii = limit prądu × napięcie systemu z P1 (jak w firmware; zmiany w zakładce Limits też się liczą), plus pozycja „bez limitu”. Domyślne moce trybów to procent tej mocy. Przed odczytem z roweru: wyraźnie oznaczone „przyjęto 15 A × 48 V”. Wykres: kop w czasie (narasta i gaśnie), moc jako poziomy pasek — w jednym polu.

### 1.0.16 — progi nacisku zawsze widoczne
Pola „Start z miejsca” i „Start w jeździe” są widoczne zawsze: przed odczytem jako podgląd fabryczny (2,5 / 1,5 kg, wyszarzone), przy firmware bez banku v11 zablokowane z informacją „wymaga 0.707 lub nowszego”.

### 1.0.17 — zrozumiałe ustawienia rowerzysty
Sekcja „Rowerzysta i model podtrzymania”: nazwy opisują odczucie (Asysta wg wysiłku, Twoja siła, Bez terkotu, Minimalna asysta przy wolnym/szybkim kręceniu w %, Wyłącz po … s bez nacisku), przy każdym mały wykres na żywo, opis w jednej linii, szczegóły pod „?”. Przed odczytem widoczne wyszarzone z wartościami fabrycznymi.

### 1.0.18

Ustawienia poziomów pokazują rzeczywiste wartości w %, sekundach i kg. Zmiana trybu zachowuje je w dostępnym zakresie.

### 1.0.19

Wartości rzeczywiste zaokrąglone czytelnie (% bez miejsc po przecinku, s do 0,01, kg do 0,1).

### 1.0.20

Po publikacji strona od razu pobiera nowe pliki (service worker sprawdza zmiany na serwerze zamiast brać kopię przeglądarki sprzed do 10 min).

### 1.0.21 — wspólna skala suwaków

To samo miejsce suwaka oznacza tę samą wartość na każdym poziomie (oś w %, s albo kg wspólna dla wszystkich trybów). Ciemniejszy pas na torze pokazuje zakres osiągalny w trybie poziomu; poza nim suwak dociąga do granicy. Kop: skrajnie w prawo = wyłączony; Podtrzymanie: 0 = wyłączone.

### 1.0.22 — prawdziwe kg i nowa mapa nacisku

„Twoja siła”, „Zakres” i „Kop” pokazują teraz prawdziwe kg na pedale (tabela czujnika). Wcześniej ekran pokazywał jednostki sterowania jako kg: „Twoja siła 30” to fizycznie 16,6 kg, „60” to 26,3 kg, czyli granica czujnika. Zapis do sterownika bez zmian. Wykresy pokazują prąd w % maksimum, ze starym sufitem 65%.
Nowy przełącznik „Nowa mapa nacisku” (firmware 0.709+, bit 13): mniej wsparcia przy lekkim nacisku, pełny nacisk daje pełny prąd silnika. Na 0.707 przełącznik jest wyszarzony.

### 1.0.23 — Podtrzymanie (Carry): prawdziwe granice

Czas i droga Podtrzymania są pokazywane z granicą firmware: najwyżej 1,2 s i 1,5 m. Wcześniej powyżej 50 ekran pokazywał np. 2,4 s · 3 m, choć firmware obcina do 1,2 s · 1,5 m, więc powyżej 50 rośnie już tylko siła. Opis mówi, kiedy funkcja naprawdę działa: zatrzymanie korby po mocnym pedałowaniu poniżej 10 km/h.

### 1.0.24 — osobne nazwy: Dopych i Minimum wsparcia

Dwie różne funkcje miały tę samą nazwę „podtrzymanie”. Teraz ustawienie poziomu Carry (krótkie pchanie po zatrzymaniu korby pod górę) nazywa się **Dopych**. Ustawienie rowerzysty (stałe minimum prądu w jeździe i szybkie wyłączenie przy kręceniu bez nacisku) nazywa się **Minimum wsparcia**. Działanie i zapis bez zmian.

### 1.0.25 — Wsparcie najwyżej 800%

Skala Wsparcia w % kończy się na 800% (decyzja właściciela). Z firmware 0.709+ (bit możliwości 14) sterownik też obcina do 800%. Na 0.707 bez tego bitu strona pokazuje pełny zakres sterownika (do 1050% w SPORT+ i BOOST).

### 1.0.26 — do firmware 0.709

Domyślna „Twoja siła” to 60, cała skala czujnika (ok. 26 kg; decyzja właściciela, lżejszy rowerzysta ustawi mniej). Wymagane do 0.709: wersje przed 1.0.22 nie odczytają rowerzysty z 0.709 (nowy bit mapy nacisku).

### 1.0.27 — jeden zapis z potwierdzeniem

Na górze „eVistDrive Profiles” jest pasek, który zawsze mówi, w jakim stanie jest ekran względem roweru:
- „Nie odczytano”;
- „Ekran = rower (odczyt HH:MM)”;
- „Niezapisane zmiany: …” z listą zmienionych pól, np. „Twoja siła”, „P3: Wsparcie”, „Progi nacisku”.

Jeden przycisk **„Zapisz na rowerze”** wysyła tylko to, co się zmieniło, zapisuje na stałe w sterowniku, odczytuje z powrotem i porównuje. Potem pasek pokazuje na zielono „Zapisano na stałe i sprawdzono odczytem (godzina)” albo na czerwono, co się nie udało. „Cofnij zmiany” wraca do odczytu bez wysyłania. Przy zamykaniu strony z niezapisanymi zmianami przeglądarka ostrzega.

Przyciski „Wyślij tylko … (do wyłączenia)” są już tylko w widoku zaawansowanym (test do wyłączenia roweru).
