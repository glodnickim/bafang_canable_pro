# CB-023 — Start condition wyłącznie w kg

Canable obsługuje bank firmware v7 bez ujawniania mV użytkownikowi.
Obie wartości nacisku są wprowadzane i wyświetlane z dokładnością 0,1 kg.

Pola poziomu:

- `Minimum pedal load (kg)`,
- `Minimum pedal load while riding (kg)`.

Parser normalizuje banki v1–v6 do tych samych nazw w stanie aplikacji. Serializer
negocjuje format:

- v7: u16 centikg kwantyzowane do 0,1 kg + u8 w 0,1 kg,
- v6 i starsze: konwersja kg do historycznych mV oraz redukcji progu.

Stare presety z `without_rotation_threshold_mv`, `start_load_reduction_mv` i
historycznymi polami usuniętego detektora są bezpiecznie importowane, ale do
nowej konfiguracji trafiają tylko dwa progi bezwzględne. Nowe presety nie
zawierają już ustawień nacisku w mV. Presety z wcześniejszymi wartościami kg o
większej dokładności również są normalizowane do jednego miejsca po przecinku.

Wykres Start condition również pracuje w kg i pokazuje dwa bezpośrednie progi,
bez odejmowania redukcji przez użytkownika.

Algorytm `Pedal-load increase to start` i `Pressure rise window` został usunięty
z aplikacji i firmware. Bajty v7 `[36..37]` są wysyłane jako zera.
