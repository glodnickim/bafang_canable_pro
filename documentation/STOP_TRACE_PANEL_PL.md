# Pomiar kliknięcia przy zatrzymaniu

## Domyślnie: automatyczne logowanie

Po jednorazowym restarcie serwera CANable otwórz aplikację i połącz adapter.
Panel sam uzbraja rejestrator. Przy komunikacie **Gotowy — wykonaj próbę**
uruchom wspomaganie i przestań pedałować. Zaczekaj, aż silnik i koło staną.
CANable sam pobierze i zapisze plik, sprawdzi CRC oraz uzbroi następny pomiar.
Podczas pobierania poczekaj na kolejną gotowość; nie jest to ciągły zapis jazdy.

Nie wpisuj poleceń, nie uruchamiaj Start Sniffing i nie szukaj pliku.
Napisz **sprawdź log** oraz czy było kliknięcie. Pliki są w `logs/stop-trace`.
Ostatni zapisany plik pozostaje widoczny również po rozpoczęciu następnej próby.

Okno oczekiwania bez zdarzenia odnawia się samo. Istniejący pomiar jest pobierany
przed zastąpieniem nowym; wyjątek to NO_TRIGGER, czyli upływ czasu bez wyzwolenia.
NO_TRIGGER z przekroczeniem czasu FOC również zostaje pobrany jako dowód diagnostyczny.
Pobieranie ponawia się automatycznie z przerwą; po trzech błędach automat się zatrzymuje.
Potwierdzone w pliku przekroczenie czasu FOC także wstrzymuje kolejne próby.
W obu przypadkach wystarczy napisać **sprawdź log** i przekazać widoczny komunikat.

Przycisk **Wstrzymaj automatyczne pomiary** zatrzymuje kolejne operacje automatu;
trwające pobieranie kończy się i zachowuje plik. Aktualizacja firmware wstrzymuje
komunikację rejestratora. Sam rejestrator nie uruchamia silnika.

## Tryb ręczny — opcjonalny

Przyciski ręczne są schowane w **Sterowanie ręczne (opcjonalne)**.
Ich użycie wyłącza automat; można wrócić przyciskiem **Wznów automatyczne pomiary**.

Panel jest na samej górze zakładki **Sniffer**: **Klik przy zatrzymaniu — STOP-TRACE**.
Po aktualizacji CANable uruchom ponownie serwer (Canable.bat → 3) i odśwież stronę.
Firmware NORMAL 0.514 zawiera wymagany rejestrator; nie trzeba go ponownie wgrywać.

1. Połącz adapter CAN i włącz sterownik.
2. Kliknij **Rozpocznij pomiar**. Poczekaj na **Gotowy — wykonaj próbę**.
3. W ciągu 30 sekund uruchom wspomaganie, następnie przestań pedałować. Poczekaj na zatrzymanie silnika i koła.
4. Przy komunikacie **Pomiar gotowy do pobrania** kliknij **Pobierz zapis**.
5. Poczekaj na **Plik zapisany — pomiar pobrany**. Pod spodem pojawi się pełna ścieżka pliku.

Nie trzeba uruchamiać Start Sniffing, wybierać filtrów, wpisywać identyfikatorów ani szukać odpowiedzi w logu.
Pliki trafiają do `logs/stop-trace` obok aplikacji. `.log` zawiera wyłącznie eksport STOP-TRACE,
a `.log.json` potwierdza kompletność i CRC (`COMPLETE_CRC_OK`). Starsze pomiary pozostają w osobnych plikach.
Do analizy wskaż ostatni plik `.log` i napisz, czy podczas próby było słychać kliknięcie.

Jeśli pojawi się błąd pobierania, zaczekaj na zatrzymanie koła i ponów **Pobierz zapis**.
Nie rozpoczynaj wtedy nowego pomiaru. Rejestrator zachowuje dane w sterowniku do kolejnego pomiaru lub wyłączenia zasilania.
Nowy pomiar odblokowuje się dopiero po poprawnym zapisaniu poprzedniego.
Przy braku wyzwolenia przez 30 sekund pobierz zapis i wykonaj następną próbę.

Zamknięcie karty przeglądarki nie przerywa pobierania, dopóki serwer CANable działa.
Sterownik wstrzymuje eksport podczas ruchu lub żądania wspomagania. Panel informuje o czekaniu;
po minucie bez nowych danych umożliwia ponowienie pobierania po zakończeniu eksportu sterownika.
Plik bez potwierdzenia `.json` należy traktować jako częściowy.

Panel obsługuje wyłącznie rejestrator; nie zmienia algorytmu hamowania silnika.
CRC potwierdza poprawne przesłanie danych, nie diagnozę przyczyny kliknięcia ani jakość pomiaru prądu.

Walidacja narzędzia: `node tests/stop_trace.js` i `node tests/stop_trace_panel.cjs`.
Automatyczny cykl: `node tests/stop_trace_auto.js`.
Testy używają symulowanych ramek, bez sterowania silnikiem.
