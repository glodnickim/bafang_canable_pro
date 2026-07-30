# CB-010 — Wykrywanie martwego łącza z adapterem, auto-naprawa, bramka przed wgrywaniem

Stan: **WDROŻONE** (2026-07-30). Testy przy biurku zaliczone, testy na rowerze **oczekują**.
Zakres: wyłącznie aplikacja CANable. Firmware roweru nietknięty.

---

## Problem odczuwany w użyciu

Po uśpieniu komputera i ponownym otwarciu aplikacja pokazuje zielone „Connected", ale
łączność z adapterem jest martwa. Wgrywanie firmware startuje mimo to, pisze w pustkę
i po ~15 s kończy się komunikatem `Step 2: Timeout reached`, który nic nie wyjaśnia.
Prawdziwy błąd widać wyłącznie w oknie terminala.

## Przyczyna — potwierdzona w kodzie

Trzy niezależne braki, które składały się na jeden objaw:

1. **`gsusb.js`, `onUSBPollError`** — obsługa błędu kanału odbiorczego USB składała się z
   jednej linii `console.log`. Komentarz nad nią mówił wprost: „zwykle powoduje to
   zatrzymanie odczytu bez możliwości powrotu". Po wybudzeniu kanał umierał, a nikt
   ponad tą funkcją się o tym nie dowiadywał.
2. **`canbus.js`, `isConnected()`** — zwracało `this.isStarted`, flagę ustawianą raz przy
   otwarciu urządzenia i nigdy nieweryfikowaną.
3. **`server.js`** — nigdy nie subskrybował zdarzenia `can_error`, więc nawet te błędy,
   które `canbus.js` zgłaszał, nie docierały do przeglądarki.

Kontrola co 3 s istniała, ale sprawdzała wyłącznie, czy adapter figuruje na liście USB.
Po wybudzeniu figuruje — martwy jest uchwyt, nie urządzenie.

## Rozwiązanie

### Czujnik życia — dwustopniowy

- **Biernie:** jeśli w ciągu ostatnich 4 s przyszła (lub wyszła) ramka, łącze
  demonstracyjnie działa. Zero kosztu, prawdziwe przez cały czas jazdy.
- **Czynnie:** dopiero gdy zrobi się cicho, pytamy **sam adapter przez USB**
  (`GSUsb.probeAlive()`, transfer sterujący `bt_const`). **Nigdy nie dotyka magistrali
  CAN.**

**Dlaczego nie odpytywanie magistrali** — rozważone i odrzucone: zaparkowany rower nie
odpowiada dokładnie tak samo jak martwy adapter, więc taki test nie odpowiedziałby na
zadane pytanie, a przy okazji śmieciłby w snifferze i logu jazdy.

Pomiar wpięty w istniejący takt 3 s (żadnego drugiego zegara), nie częściej niż co 5 s.
Błąd twardy (`NO_DEVICE`, `NOT_FOUND`) = śmierć od razu; błąd miękki (`IO`, `PIPE`,
`TIMEOUT`) wymaga dwóch prób — bo `sendRawFrameWithRetry` w updaterze z założenia ponawia,
a jeden odzyskiwalny błąd nie może zabić wgrywania, które by się udało.

**Wykrycie uśpienia:** przerwa większa niż 10 s między taktami oznacza, że proces spał —
wymusza pomiar w tym samym takcie. Najtańszy dostępny sygnał wybudzenia.

### Auto-naprawa

`attemptAutoRecovery()` w `server.js`: żółty status → zamknięcie martwego uchwytu (w
wyścigu z zegarem, bo `close()` na martwym urządzeniu potrafi zawisnąć w libusb) →
sprawdzenie obecności → ponowne otwarcie → **weryfikacja pomiarem**. Backoff 1/2/4/8/15 s,
pięć prób, potem czerwony z powodem.

Weryfikacja po `init()` jest konieczna: `GSUsb.start()` potrafi zwrócić
„Stop in progress, retry scheduled" i zaplanować własne ponowienie, więc samo `init()`
może „się udać" na martwym uchwycie.

Osłony: naprawa ustępuje trwającemu wgrywaniu firmware (nie wyrywa uchwytu spod niego),
auto-połączenie ustępuje naprawie (dwie ścieżki nie mogą naraz wołać `init()`), a ręczne
Connect/Disconnect i fizyczne przepięcie kasują stan i zaplanowane ponowienie.

### Bramka przed wgrywaniem — TYLKO ADAPTER

Przed pierwszym bajtem serwer sprawdza, czy adapter odpowiada. Odmowa = czytelny powód +
`FW_UPDATE_END:FAILED`, zero ramek na magistrali, zero pliku logu. Ten sam test siedzi w
`startUpdateProcedure`, bo `fw-update-cli.js` omija serwer.

Śmierć łącza w trakcie wgrywania łapana jest w `sendRawFrameWithRetry` — przechodzą przez
nią wszystkie kroki, więc zgłoszenie następuje w ~1 s zamiast przy następnym punkcie
kontrolnym (do 255 porcji dalej).

`FW_UPDATE_END` niesie wynik (`:OK` / `:FAILED:powód`). Wcześniej był gołym komunikatem
wysyłanym w obu przypadkach, więc **nieudane wgranie wyglądało identycznie jak udane**.
Przy porażce plik zostaje w polu wyboru, żeby powtórka nie wymagała szukania go od nowa.

### Interfejs

Dwa nowe stany: `RECOVERING` (bursztynowy, „Link lost — reconnecting…") i `LINK_LOST`
(czerwony, powód, aktywny przycisk Reconnect — droga wyjścia musi zostać dostępna).
Oba resetują wykrywanie sterownika, żeby karty eVistDrive nie udawały potwierdzonych.

**Bramkowanie zapisów** (`updateWriteControlsGating`) — celowo oddzielone od
`enableAppControls`: przeglądanie kart bez roweru zostaje nietknięte, blokowane są
wyłącznie kontrolki oznaczone `data-requires-link`, każda z widoczną odznaką „?"
tłumaczącą powód.

> **Dla przyszłych zmian:** każdy NOWY przycisk zapisujący do sterownika musi dostać
> atrybut `data-requires-link` w `ui/index.html`. Bez niego da się go kliknąć bez
> połączenia i nic się nie stanie — po cichu.

---

## Czego to NIE naprawia

- **Wyłączonego roweru przy wgrywaniu.** Świadoma decyzja: bramka sprawdza adapter, nie
  rower. Ten przypadek nadal kończy się błędem, ale komunikat został przepisany na
  „sterownik nie zgłosił gotowości — czy rower jest włączony i wiązka podłączona?".
- **Zerwanej wiązki CAN.** Jak wyżej.
- **Braku sterownika WinUSB.** Osobny temat — objawia się tym, że adapter *nigdy* się nie
  łączy, a nie że przestaje po uśpieniu.

## Naprawione po drodze (warunek konieczny)

- **Mnożenie nasłuchiwaczy:** `canbus.js` rejestrował `frame` i `error` przy każdym
  połączeniu, jako funkcje strzałkowe, a `GSUsb.on()` nie ma `off()`. Bez tej naprawy
  auto-naprawa mnożyłaby parsowanie ramek z każdym cyklem uśpienia. Teraz raz, w
  konstruktorze.
- **Zombie uchwyt:** `_handleCanError` gasił flagę, ale nie zwalniał urządzenia.

---

## Plan testów i stan

| # | Test | Stan |
|---|---|---|
| 1 | Atrapa: martwy pomiar gasi połączenie, emituje **raz**, powtórka nie emituje | ZALICZONY |
| 2 | Wyrwanie wtyczki → czerwony; wpięcie → zielony bez działania użytkownika | do zrobienia |
| 3 | **Uśpienie i wybudzenie z podłączonym rowerem** — pastylka żółknie w 3-6 s, wraca zielona sama albo czerwona z powodem, w logu **jeden** `can_error`, brak zdublowanych `BAFANG_DATA` | **DO ZROBIENIA — decyduje o zaliczeniu** |
| 4 | **Zaparkowany rower** (adapter podłączony, rower wyłączony, 5 min) → musi zostać zielony | **DO ZROBIENIA — anty-regresja** |
| 5 | Adapter odpięty → Flash zablokowany, żądanie odrzucone z powodem, zero ramek | ZALICZONY |
| 6 | Wyrwanie wtyczki przy ~20% wgrywania → komunikat w ~1 s, plik zostaje | do zrobienia |
| 7 | Udane wgranie kończy się `FW_UPDATE_END:OK` | do zrobienia |
| 8 | 5 cykli uśpienia → `canDevice._listeners.frame.length === 1` | do zrobienia |

Testy 3 i 4 wymagają roweru i realnego uśpienia komputera. To one decydują o zaliczeniu.

## Commity

```
5bf63e4 fix(canbus): bind frame/error handlers once and release the handle after a link error
30d934f fix(gsusb): report a dead RX pipe instead of logging it, and add an adapter probe
872829f feat(canbus): checkAlive() — answer whether the link is really up
74d7e1c feat(server): surface a dead CAN link and recover from it automatically
d264e41 feat(fw-update): check the adapter before the first byte, abort on link loss
92dff3f feat(ui): show a lost link instead of a green pill over a dead connection
```

## Plan powrotu

Każdy etap jest osobnym commitem w powyższej kolejności. `git revert` od ostatniego do
pierwszego przywraca stan sprzed zmiany. Etap `5bf63e4` (bind-once) warto zostawić nawet
przy wycofywaniu reszty — naprawia realny błąd niezależny od tej funkcji.
