# CANable Pro — równoległy interfejs EBICS Ride Core

Stan dokumentu: 2026-07-17

## Tymczasowy tryb podglądu podczas budowy UI

W `ui/js/ebics-detection.js` znajduje się przełącznik:

```js
export const EBICS_UI_PREVIEW_WITHOUT_DETECTION = true;
```

Wartość `true` pokazuje wszystkie osobne karty bez podłączonego CAN i bez wykrycia EBICS. Dane zapisywalne nadal wymagają połączenia oraz wcześniejszego odczytu z kontrolera. Po zakończeniu prac wizualnych ustawienie `false` przywróci pokazywanie kart dopiero po poprawnym wykryciu sterownika.

## Cel i zasada zgodności

Nowy interfejs EBICS został dodany równolegle. Nie usunięto i nie ukryto istniejących kart `Controller`, `Display`, `Sensor`, `Battery`, `Assist`, `Banks` ani pozostałych funkcji fabrycznego Bafanga. Pozwala to porównywać oba widoki podczas testów i nadal używać CANable z fabrycznym sterownikiem.

Automatyczne wykrywanie ma cztery stany robocze:

- `unknown` — brak połączenia lub brak wyniku;
- `detecting` — trwa wyłącznie odczytowa próba bloku banku;
- `factory_bafang` — w czasie 1,8 s nie otrzymano poprawnej sygnatury EBICS;
- `ebics` — odebrano bank z nagłówkiem `EB`, wersją schematu 1 i poprawnym CRC.

Próba wykrywania wysyła tylko `READ_BANK:0`, czyli odczyt bloku `0x6020`. Nie wysyła komendy zapisu. Brak odpowiedzi pozostawia pełny interfejs fabryczny. Poprawna, nawet spóźniona odpowiedź może przełączyć wynik na EBICS.

Ważne ograniczenie: starszy wariant EBICS Legacy, który nie obsługuje banków Ride Core `0x6020`, nie ma jeszcze jednoznacznej sygnatury. Do czasu dodania komendy capabilities zostanie rozpoznany jak sterownik fabryczny.

## Wdrożone osobne karty EBICS

Karty EBICS są niewidoczne do chwili potwierdzenia sygnatury Ride Core:

1. `EBICS Live` — bank, poziom, silnik wspomagania, nacisk w kg, kadencja, prędkość, moc elektryczna, prąd, temperatury i wykres kroczący.
2. `EBICS Profiles` — osobny edytor banku i poziomu. Pokazuje tylko pola właściwe dla wybranego silnika:
   - Power Linear: wsparcie mocy rowerzysty w `%`;
   - Power Progressive: minimum, maksimum, moc odniesienia i progresja;
   - Torque TSDZ: `Torque gain`, gdzie 120 oznacza 1,0×;
   - eMTB TSDZ: czułość, zależność od kadencji i napięcie odniesienia.
3. `EBICS Torque` — odczyt nacisku 0–60 kg, wskaźnik oraz jawny kontrakt autokalibracji.
4. `EBICS Dynamics` — oddzielne rampy narastania/opadania dla niskiej i wysokiej prędkości/kadencji oraz wykres zaniku startup boost.
5. `EBICS Limits` — limity prądu, mocy i Iq, pełna edycja elektryki/baterii, Legal Flag oraz bloku prędkości i koła.
6. `EBICS Walk` — funkcjonalny odczyt/zapis prądu i prędkości Walk Legacy oraz miejsca na przyszłe minimum/maksimum ERPS i rampę.
7. `EBICS Legacy` — funkcjonalne edytory `0x6010`, `0x6011`, `0x6012` i `0x62D9`: pięć poziomów, progi torque w kg, `assist_profile[5][6]`, TQ filter i magazyn Extended Boost.
8. `EBICS System` — ustawienia silnika, czujnika prędkości, PAS, manetki i timingów Legacy, błędy, kalibracja pozycji, naprawa checksum oraz diagnostyka protokołu.

Stara karta `Banks` pozostała bez zmian na czas walidacji.

## Krok drugi — zastąpienie Controller i Assist

Nowe karty mają własny model roboczy i nie wymagają otwierania starych kart `Controller` ani `Assist (Full)`. Jedno polecenie Sync odczytuje kolejno błędy, P0, P1, P2, blok prędkości i `0x62D9`. Zapisy są dostępne dopiero po poprawnym odczycie wymaganych bloków w bieżącym połączeniu.

Przeniesiono wszystkie pola używane przez firmware EBICS. Nazwy wynikają z `src/parser.c`, a nie ze standardowego opisu Bafanga. Przykłady:

- standardowe `Motor Type` jest w EBICS kierunkiem silnika;
- standardowe `Motor Pole Pair Number` przechowuje przełożenie;
- standardowe `Max Motor RPM` przechowuje Magic Number;
- standardowe pola temperatury/ramp przechowują `decay_base`, PAS timeout i ramp-end Legacy;
- standardowy `Speed Limit Enabled` przechowuje prąd Walk w procentach.

Bajty fabryczne, których EBICS nie używa, nie zostały pokazane jako pozornie działające ustawienia. Pozostają dostępne w Debug/raw. Wspólne karty `Display`, `Battery`, `Info`, `Firmware`, `Sniffer`, `Ride Logger` i `Data Backup` nadal są wspólne dla obu rodzajów sterownika.

## Zasady czujnika nacisku

- Użytkownik widzi kg, nie mV.
- Punkt zerowy nie ma ręcznego pola i ma pozostać automatycznie kalibrowany przez firmware przy uruchomieniu.
- Skala użytkownika kończy się na 60 kg.
- Dolny próg `without_rotation_threshold_mv` jest prezentowany i edytowany jako względny nacisk w kg, ale z realnym limitem firmware `0-7,5 kg` (`0-300 mV` przy `40 mV/kg`); na przewodzie nadal pozostaje natywna wartość firmware.
- Legacy `Lower torque threshold` jest innym progiem: dla obecnego `TQ_FULL_SCALE_MV=2000` UI ogranicza go do `0,0-31,2 kg`, żeby próg nie wychodził poza liniową mapę `nacisk -> prąd`.
- Interfejs nie udaje, że zna zapisany punkt górny kalibracji. Odczyt i zapis górnego punktu wymagają przyszłego, jednoznacznego bloku protokołu.

`Torque gain` nie jest tym samym co `Support (%)`: gain skaluje cel wyliczony z nacisku, natomiast support mnoży oszacowaną moc rowerzysty w silniku Power.

## Obsługiwane operacje zapisu

- Profiles: odczyt obu banków, zapis wybranego banku do RAM, utrwalenie przez `SAVE_BANKS`.
- Dynamics: odczyt tuningu, zapis do RAM, utrwalenie wspólnie z bankami.
- Profiles używa realnego limitu firmware dla `Startup boost end cadence`: `0-120 rpm`.
- Limits: zapis używanych pól P1 oraz kompletnego bloku prędkości/koła.
- Limits pokazuje tabelę działania `Limp SoC` zgodną z aktualnym `compute_limp_factor()` firmware: powyżej Stage 1 zostaje `100%` prądu fazowego; bez aktywnego Stage 2 spadek jest liniowy do `30%` przy `0% SoC`; z aktywnym Stage 2 najniższy punkt wynosi `15%` przy progu Stage 2, a obecny kod poniżej tego progu wraca liniowo do `30%` przy `0% SoC`.
- Walk: zapis prądu i prędkości Walk do P1.
- Legacy: zapis P0, limitów poziomów P1, P2 i TS coefficient `0x62D9`.
- System: zapis kierunku/przełożenia silnika, czujnika prędkości, Magic Number, manetki, PAS i timingów Legacy; dodatkowo kalibracja pozycji, natywne przywracanie domyślnych ustawień kontrolera `0x6101`, kasowanie błędów oraz naprawa checksum P1/P2.
- Ręczna kalibracja zera torque nie została przeniesiona — dla EBICS zero zawsze pozostaje automatyczne. Dawna komenda `Calibrate Torque Sensor` (`0x6101`) jest w tym firmware używana jako reset EEPROM / przywrócenie ustawień domyślnych, więc w nowych kartach występuje jako `Restore controller defaults`.
- Nowy edytor nie pozwala wysłać banku, który w bieżącym połączeniu nie został wcześniej odczytany.
- Edytory zgodności nie pozwalają zapisać P0/P1/P2/speed/startup, jeśli wymagany blok nie został odczytany w bieżącym połączeniu.
- Wszystkie operacje zapisu wymagają jawnego kliknięcia użytkownika; wykrywanie ich nie uruchamia.

## Celowo niewymyślone dane

Do czasu rozszerzenia firmware/protokołu jako `N/A` lub `protocol pending` pozostają:

- aktualny właściciel sterowania i aktywny limiter;
- zapisany punkt górny kalibracji torque oraz aktualny surowy wynik autokalibracji;
- osobne minimum/maksimum ERPS i rampa Walk;
- porównanie Saved vs Runtime i polecenie Revert;
- jednoznaczna komenda capabilities dla EBICS Legacy.

## Procedura testu sprzętowego

### A. Fabryczny sterownik Bafang

1. Uruchomić aplikację ze źródeł i podłączyć CANable.
2. Sprawdzić, czy plakietka przechodzi `unknown → detecting → factory Bafang`.
3. Potwierdzić, że karty EBICS pozostają ukryte.
4. Przejść przez `Controller`, `Display`, `Sensor`, `Battery`, `Assist`, `Info` i wykonać zwykłe odczyty.
5. Nie wykonywać zapisu podczas pierwszego testu. Sprawdzić, czy odczytowa próba `0x6020` nie zmieniła żadnej wartości.

### B. Sterownik EBICS Ride Core

1. Połączyć CANable i sprawdzić wynik `Controller: EBICS`.
2. Otworzyć `EBICS Profiles`, kliknąć `Read banks` i porównać oba banki ze starą kartą `Banks`.
3. Zmienić jedną bezpieczną wartość w wybranym poziomie, użyć `Apply selected bank (RAM)` i sprawdzić zachowanie bez zapisu Flash.
4. Sprawdzić wykres każdej z czterech metod wspomagania.
5. Na `EBICS Torque` sprawdzić 0 kg bez nacisku i rosnącą wartość przy nacisku. Nie powinno istnieć ręczne ustawienie zera.
6. Na `EBICS Dynamics` odczytać tuning, zmienić jedną rampę w RAM i sprawdzić wykres/reakcję.
7. Wykonać `Sync controller blocks` w `EBICS Limits`, porównać P1 i blok prędkości ze starym ekranem, a następnie przetestować jedną bezpieczną zmianę.
8. W `EBICS Walk` sprawdzić zapis wartości dziesiętnej, np. `5,5 km/h`, i ponowny odczyt.
9. W `EBICS Legacy` porównać pięć poziomów oraz macierz `assist_profile[5][6]`; najpierw testować małą zmianę jednego poziomu.
10. W `EBICS System` sprawdzić odczyt konfiguracji i błędów. Kalibrację pozycji wykonywać tylko ze zdjętym łańcuchem; ręcznej kalibracji zera torque nie ma.
11. Dopiero po potwierdzeniu działania wykonać `Save (Flash)` na postoju.
12. Rozłączyć i połączyć ponownie; potwierdzić ponowne wykrycie oraz trwałość zapisanych wartości.

## Weryfikacja wykonana bez sprzętu

- ESLint dla zmienionych modułów UI: zaliczony.
- Sprawdzenie unikalności wszystkich identyfikatorów HTML: brak duplikatów.
- Zgodność przycisków kart z kontenerami kart: 21/21.
- Test HTTP uruchomionej aplikacji: strona główna, `tab-ebics.js` i `ebics-compat.js` zwracają 200; znaleziono wszystkie wymagane kontenery kroku drugiego.
- Test serializacji P1: Walk `5,50 km/h` daje poprawny zapis natywny `550`, bez wcześniejszej utraty części dziesiętnej.
- Test DOM w Edge: widocznych 8 kart EBICS; utworzono 13 kontrolek Limits, 2 Walk, 11 System oraz po 5 wierszy poziomów i profili Legacy.
- Test ładowania w trybie headless Edge: moduły wykonały się, a stan bez CAN został poprawnie ustawiony na `unknown`.
- Test na prawdziwym sterowniku fabrycznym i EBICS: do wykonania według procedury powyżej.
