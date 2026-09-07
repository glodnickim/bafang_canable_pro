# Pomiar kliknięcia przy zatrzymaniu

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
Testy używają symulowanych ramek, bez sterowania silnikiem.
