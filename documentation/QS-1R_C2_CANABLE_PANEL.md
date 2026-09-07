# QS-1R-C2 — prosty panel pomiaru QS-1R w Canable (POMIAR QS-1)

- **Data:** 2026-08-30
- **Zakres:** wyłącznie aplikacja Canable (serwer + panel w zakładce **Sniffer**).
  **Firmware nietknięty, protokół CAN nietknięty, raw-log nietknięty.** Wszystkie fakty
  protokołu przypięte do builda DIAG `eVD 0.0413` (commit firmware `7232f9d`) na podstawie
  `src/CAN_Display.c`, `src/qs_transition_diag.c/.h`, `src/qs_transition_dump.c`.
- **Język UI:** angielski (reszta aplikacji jest po angielsku). Mapowanie napisów z zadania:
  GOTOWY DO POMIARU → READY TO MEASURE, ZAPISYWANIE → CAPTURING, POMIAR GOTOWY → MEASURE
  READY, POBRANIE → DOWNLOADING, BŁĄD → ERROR.

## 1. Po co i czego panel NIE robi

Panel to normalny-userowy mechanizm zbierania **48 próbek QS-1R** (48 × 44 B danych FOC wokół
zbocza narastania mocy). Działa:

- **bez wpisywania czegokolwiek w trybie RAW CAN** — nawet nie wymaga „Start Sniffing";
- **bez cykli zasilania silnika** — ponowny zjazd wykonuje `NEW MEASURE` (WRITE 0x6031);
- bez „reconnecta" — serwerowy `Qs1Service` jest procesowy i słucha raz (S3: pętla
  „capture → download → new capture → capture → download" bez końca na jednym połączeniu).

Panel **nie** dotyka FOC, MOE, FW117, baterii, kalibracji ani formatu próbek QS. Nie filtruje,
nie kasuje i nie modyfikuje żadnej ramki: sniffer w dalszym ciągu loguje do pliku wszystko, co
logował.

## 2. Co dolega do magistrali (on-wire)

| Cel | Id | Operacja | DLC | Odpowiedź |
|---|---|---|---|---|
| STATUS | `85116031` | READ 0x6031 | 0 | `822A6031` DLC 8 (patrz niżej) |
| NEW MEASURE | `85106031` | WRITE 0x6031 | 0 | `822A6031` DLC 0 (NORMAL_ACK) lub `822B6031` |
| DOWNLOAD | `85106030` | WRITE 0x6030 | 0 | `822A6030` DLC 0 (NORMAL_ACK) lub `822B6030` |

Status `0x822A6031` DLC 8 (potwierdzone w `send_qs_transition_status`):

```
d[0] = 1                schema
d[1] = stan            1 ARMED / 2 TRIGGERED / 3 COMPLETE (0 IDLE nie wychodzi na wire)
d[2] = generation       zaczyna od 1, +1 przy ponownym zjeździe
d[3] = sample_count     0..48
d[4] = flags           bit0 export_ready, bit1 export_busy
d[5] = trigger_events
d[6] = trigger_index
d[7] = 0
```

> **Kluczowa reguła:** WRITE 0x6031 (NEW MEASURE) to tylko „otwarcie linii". Zatwierdzeniem
> jest **późniejszy STATUS** pokazujący nową `generation` **i** stan ARMED — czyszczenie
> pierścienia robi ISR, więc jedynie odpowiedź samego firmware potwierdza sukces. WRITE
> 0x6031 jest przyjmowany tylko dla pomiaru COMPLETE, którego dump nie jest w trakcie.
> WRITE 0x6030 tak samo — tylko COMPLETE, bez aktywnego dumpu.

## 3. Export: strumień 0x80010250…56

Jedna próbka = 1 nagłówek + 6 fragmentów (44 B rozłożone na 6 × 8 B, ostatni ma 4 znaczące):

```
80010250   [1, capture_id, index, trigger_index, 44, 6, 48, 0]
80010251   bajty 0..7       80010252  bajty 8..15  …  80010256  bajty 40..43(+padding)
```

Firmware nadaje z `DIAG_TX_FRAME_INTERVAL_MS = 10 ms` (336 ramek ≈ 3,4 s) i **tylko gdy
sesja jazdy jest nieaktywna** (rower stoi; sesja domyka się po 3 s ciszy). Stąd:
`firstFrameTimeoutMs = 8000` (nagłówek musi się pojawić; komunikat prosi o parkowanie
roweru), `stallTimeoutMs = 2500` (cisza mid-stream → INCOMPLETE z licznikiem rekordów).

### Izolacja od PAS

Rodzina `8001021D, 80010218, 80010216, 80010217, 8001021B, 8001021C` to **diagnostyka sesji
jazdy**, nie dane QS. Bramka PAS działa przed czymkolwiek innym w serwisie — te ramki nie
liczą się do żadnej próbki i nie potrafią skorumpować assembly (testy T13 + T18n).

## 4. Werdykty — nigdy „po nadziei"

- **NEW MEASURE = OK** dopiero po STATUS: nowa `generation` ORAZ ARMED. Inaczej FAILURE
  z powodem (E1_TIMEOUT → „no STATUS confirmed a new generation…"; ERROR_ACK → „rejected…").
- **DOWNLOAD = OK** dopiero gdy assembler trzyma **wszystkie 48 kompletnych rekordów**
  (żadnych brakujących, żadnych `badHeaders`, `suspect` false). Inaczej:
  `Measure N — INCOMPLETE — x/48` (z listą brakujących indeksów w payloadzie).
- Generacja, którą pobrano i zweryfikowano (48/48), staje się `lastDownloadedGeneration`.
  Nowy pomiar na tej samej generacji nie prosi o potwierdzenie; świeży COMPLETE innej
  generacji (a więc **niewieziony jeszcze niczym**) chroni panel pytaniem
  „…has not been downloaded yet. Continue?" — potwierdzenie jest po stronie UI,
  a serwer i tak rezygnuje tylko z COMPLETE.

## 5. Jak to działa (architektura)

- `qs1-protocol.js` — czysta wiedza protokołu: frame-y, layout statusu, mapa stanów, reguły
  przycisków i potwierdzenia, assembler `Qs1Download`, sformułowania wyników. Bez DOM, bez
  socketów, bez importów — testowane wprost w Node.
- `qs1.js` — serwerowy `Qs1Service` (CommonJS): słucha `canbus.raw_frame_received` **wprost**
  (nie przez sniffer), poll STATUS co 2 s (tylko gdy jest ≥1 subskrybent i zaholowany podczas
  downloadu), prowadzi WSZYSTKIE timery (confirm 4 s, first-frame 8 s, stall 2,5 s), buduje
  4 komunikaty dla panelu. Nigdy nie filtruje ani nie kasuje ramek.
- `server.js` — instancja serwisu, subskrypcje WS (`QS1_SUBSCRIBE` / `removeSubscriber` przy
  zamknięciu połączenia), komendy `QS1_REFRESH` / `QS1_NEW_CAPTURE` / `QS1_DOWNLOAD`.
- `ui/js/evistdrive/qs1-panel.js` — panel: renderuje `QS1_STATUS` / `QS1_NEW_CAPTURE_RESULT`
  / `QS1_DOWNLOAD_PROGRESS` / `QS1_DOWNLOAD_RESULT`, wysyła komendy, pilnuje przycisków
  (`buttonRules`), potwierdzenia nadpisania i bloquady podczas trwających operacji.
- `ui/js/can-frame-info.js` — siatka `ALL_DIAG_PATTERNS` = diag dump + QS; dzięki temu
  preset **Dump Only** pokazuje/tworzy też kafelki QS, a tooltipy mają opisy.

## 6. Komunikaty WS

| Kierunek | Komunikat | Payload |
|---|---|---|
| serwer → | `QS1_STATUS:` | `{connected, wireState, state, generation, samples, exportReady, exportBusy, triggerEvents, triggerIndex, error, lastReceivedAt}` |
| serwer → | `QS1_NEW_CAPTURE_RESULT:` | `{success, generation, message}` |
| serwer → | `QS1_DOWNLOAD_PROGRESS:` | `{state, generation, complete, total}` |
| serwer → | `QS1_DOWNLOAD_RESULT:` | `{success, generation, got, total, incomplete, snapshot, message}` |
| ← panel | `QS1_SUBSCRIBE` / `QS1_REFRESH` / `QS1_NEW_CAPTURE` / `QS1_DOWNLOAD` | — |

## 7. Pliki

| Plik | Zmiana |
|---|---|
| `qs1-protocol.js` | NOWY — czysta wiedza protokołu + assembler + reguły UI/panela |
| `qs1.js` | NOWY — `Qs1Service` (poll, nowy pomiar, download, broadcast, bramka PAS) |
| `server.js` | podpięcie serwisu + subskrypcje/komendy WS |
| `ui/js/evistdrive/qs1-panel.js` | NOWY — panel w zakładce Sniffer |
| `ui/js/websocket.js` | routing `QS1_*` |
| `ui/js/evistdrive/index.js` | inicjalizacja panelu |
| `ui/index.html` | karta POMIAR QS-1 (po panelu FW-126), opis Dump Only |
| `ui/js/can-frame-info.js` | `QS_FRAME_PATTERNS` + `ALL_DIAG_PATTERNS` (preset Dump Only) |
| `tests/qs1_protocol.js` | NOWY — T1…T17 |
| `tests/qs1_service.js` | NOWY — T18 (end-to-end na fałszywej magistrali) |
| `package.json` | oba testy dopięte na końcu łańcucha `npm test` |

## 8. Testy

`npm test` (cały łańcuch, w tym wcześniejsze 17 plików) oraz `npm run lint` przechodzą.
Podsumowanie QS: `node tests/qs1_protocol.js` → **ALL CHECKS PASSED (T1..T17)**,
`node tests/qs1_service.js` → **ALL CHECKS PASSED (T18)**.

Test T18 przechodzi pełną pętlę S3 **dwukrotnie na jednym połączeniu** używając fałszywego
sterownika odpowiadającego jak build `7232f9d` (READ→status, WRITE 0x6031→NORMAL_ACK +
późniejszy STATUS nowej generacji ARMED, WRITE 0x6030→NORMAL_ACK + replay 336 ramek), z
wymieszanymi ramkami PAS i scenariuszem ERROR_ACK. Żadnych regresji w pozostałych testach.

## 9. Do ręcznego sprawdzenia w przeglądarce (bez HW)

- [ ] zakładka Sniffer pokazuje kartę **QS-1 MEASURE** z priorytetem DOWNLOAD/NEW MEASURE
- [ ] bez podłączonego adaptera status mówi `NOT CONNECTED`, przyciski zablokowane
- [ ] po podłączeniu poll STATUS startuje automatycznie (widać `85116031` w raw logu)
- [ ] `Dump Only` preset dodaje kafelki `85116031`, `85106030`, `85106031`, `822A6030`,
      `822B6030`, `822A6031`, `822B6031`, `80010250`…`80010256` z tooltipami
- [ ] nowy pomiar startuje tylko z MEASURE READY; z innego stanu przyciski martwe
- [ ] potwierdzenie „has not been downloaded yet" pojawia się tylko dla COMPLETE innej
      generacji niż ostatnio pobranej (48/48)
- [ ] komunikat „Measure N — 48/48 — OK" / „…INCOMPLETE — x/48" jak w zadaniu

## 10. Werdykt + lista kontrolna (host-only)

Weryfikacja dokumentowa: TAK (status/ACK podpięte do `send_qs_transition_status` i
`sendWriteResult` w buildzie `7232f9d`; geometria exportu do `qs_transition_dump.c`).
Testy aplikacyjne: T1…T18 na hoście — WSZYSTKIE PASS, pełny `npm test` + `npm run lint`
bez regresji. Test HW nie był możliwy (brak sprzętu) i nie jest wymagany dla werdyktu.

- [x] 1. Panel na zakładce Sniffer, zachodnie reguły przycisków, status auto-poll
- [x] 2. NEW MEASURE = WRITE 0x6031 DLC 0, sukces wyłącznie z potwierdzającego STATUS
- [x] 3. DOWNLOAD = WRITE 0x6030 DLC 0, 48/48 assembler, INCOMPLETE z licznikiem i indeksami
- [x] 4. Wyświetlania: numer pomiaru (generation), licznik x/48, werdykty wg zadania
- [x] 5. Generacja rośnie na re-arm; świeży COMPLETE chroniony pytaniem o pobranie
- [x] 6. Izolacja PAS (rodzina 0x1021D/…), raw-log bez zmian, brak poluzowanego sniffera
- [x] 7. Dowolny stan procesu (offline, waiting, receiving) — przyciski i status uczciwe
- [x] 8. Dump Only preset i tooltips obejmują ramki QS-1 (siatka `ALL_DIAG_PATTERNS`)
- [x] 9. `npm test` + `npm run lint` — cały łańcuch PASS, zero regresji
- [x] 10. Dokumentacja: ten plik; firmware `7232f9d` nietknięte, bez prośby o test HW

**Werdykt: B** — panel działa w pełni na hoście zgodnie z protokołem builda `7232f9d`;
pozostaje walidacja sprzętowo-sesyjna (rzeczywista sesja jazdy, timing 10 ms dumpu, zachowanie
PAS na żywej magistrali), która wymaga podpięcia roweru.