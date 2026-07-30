# CB-012, CB-013, CB-014 — przywracanie ustawień, dymki podpowiedzi, tożsamość urządzeń

Stan: **WDROŻONE** (2026-07-30). Potwierdzenie w realnym użyciu **oczekuje**.

---

# CB-012 — Powrót do ustawień wyjściowych

## Problem odczuwany w użyciu

Po wyklikaniu się w profilach albo w strojeniu nie było jak wrócić. Żadnego cofnięcia,
żadnego „przywróć".

## Co znalazłem, zanim dodałem przycisk

Dwie dziury, przez które przycisk „Default" nie miałby do czego wracać:

1. **Nie istniała kopia odczytu.** Edytor profili pisze wprost w `state.lastBanks` — a to
   jest jednocześnie „to, co przyszło ze sterownika". Pierwsza zmiana pola kasowała
   oryginał. Karta Dynamics tak samo, w `state.lastTuning`.
2. **Edycja offline psuła same wzorce.** `placeholderLevel()` oddawał obiekty **z tablicy
   wartości domyślnych**, nie ich kopie. Pokręcenie suwakami bez podłączonego roweru
   trwale przedefiniowywało „domyślne" na resztę sesji. Przycisk przywracania odtworzyłby
   wtedy to, co ostatnio wpisano.

Jedno i drugie było błędem niezależnie od nowej funkcji.

## Rozwiązanie

**Fundament:** `websocket.js` przy każdym odczycie odkłada nietkniętą kopię —
`state.lastBanksAsRead` i `state.lastTuningAsRead`. Edytor offline pracuje na kopii, a
tablica domyślnych stała się tylko do odczytu.

**Dwa sposoby powrotu**, bo odpowiadają na różne potrzeby:

- **Przycisk „Restore"** na kartach Profiles i Dynamics — cofa całą kartę.
- **SHIFT + kliknięcie na polu** — cofa wyłącznie to jedno pole. Wbudowane w `fieldInput`,
  więc każda karta, która poda `restoreValue`, dostaje to automatycznie.

**Reguła źródła** (obie drogi taka sama): jeśli cokolwiek odczytano ze sterownika →
wracamy do wartości odczytanych; jeśli nie → do fabrycznych. Okno potwierdzenia i wpis w
logu **mówią wprost, które z dwóch** zostało użyte.

**Nic nie leci do roweru.** Sterownik zachowuje swoje ustawienia aż do naciśnięcia
„Write (RAM)". To jest zaleta: można cofnąć bałagan, obejrzeć wykresy i porównać, zanim
cokolwiek zostanie wysłane. Przyciski celowo **nie** mają `data-requires-link` — cofanie
własnych kliknięć musi działać także bez podłączonego roweru.

## Testy (zaliczone)

Na prawdziwym module, przez atrapę DOM:

1. Edycja offline nie rusza tablicy domyślnych.
2. „Restore" offline przywraca wartość fabryczną.
3. „Restore" po odczycie wraca do wartości **odczytanej**, nie do fabrycznej.
4. Przywrócone dane są kopią — kolejna edycja nie psuje nietkniętego odczytu.

## Czego to NIE robi

- **Nie cofa tego, co już zapisano do sterownika.** Jeśli nacisnąłeś „Write (RAM)" albo
  „Save (Flash)", przywrócenie zmieni tylko ekran. Żeby cofnąć to w rowerze, trzeba po
  przywróceniu nacisnąć „Write (RAM)" jeszcze raz.
- **Nie jest historią kroków.** Wraca do punktu wyjścia, nie o jedną zmianę wstecz.

---

# CB-013 — Dymki podpowiedzi ucinane przy krawędziach

## Problem

Opisy pól przy brzegu strony były przycięte i nie dało się ich doczytać.

## Przyczyna — dwie naraz

1. **Kontenery z przewijaniem.** Dymek pozycjonowany `absolute` jest przycinany przez
   każdy nadrzędny element, który się przewija — a w znacznikach jest **37** kontenerów
   `overflow-x-auto`. Podpowiedź w szerokiej tabeli była obcinana niezależnie od tego,
   gdzie stała strona.
2. **Krawędź okna.** Dymek wyśrodkowany na znaczku przy brzegu po prostu wychodził poza
   ekran.

Wcześniejsze obejście przesuwało dymek dla parzystych kolumn i pasków narzędzi — trafiało
w część przypadków z prawej strony i w nic więcej.

## Rozwiązanie

Dymek jest teraz `position: fixed` (wychodzi poza wszystkie przewijane kontenery), a
`helpBadge()` go ustawia: wyśrodkowany nad znaczkiem, wciągnięty z powrotem do okna gdy
się nie mieści, przerzucony pod znaczek gdy przeszkadza góra okna. Strzałka nadal celuje w
znaczek dzięki własności `--arrow-x`.

**Test:** pięć skrajnych położeń (środek, skrajnie prawo, skrajnie lewo, sama góra, prawy
górny róg) — sprawdzane wszystkie cztery krawędzie, to że strzałka mieści się w dymku i to,
że nadal pokrywa się ze środkiem znaczka. Zaliczone.

---

# CB-014 — Tożsamość urządzeń w karcie eVistDrive System

## Problem

Pytanie właściciela: czy zakładka eVistDrive System zawiera to, co zakładka Info?

**Nie zawierała nic z tego.** System dotyczy zachowania (wykrywanie, akcje serwisowe,
błędy, transport, diagnostyka jazdy). Info dotyczy tożsamości sprzętu. Zero pokrycia.
Do tego Info nie było oznaczone jako karta fabryczna, więc przełącznik „pokaż tylko
eVistDrive" jej nie ukrywał — a ukrycie bez zamiennika zabrałoby numer seryjny i wersję
oprogramowania dokładnie wtedy, gdy są potrzebne do diagnozy.

## Rozwiązanie

Karta **„Device identification"** na górze zakładki eVistDrive System: cztery urządzenia
(sterownik, wyświetlacz, czujnik nacisku, bateria) i **wszystkie 24 pola**, które czyta
stara zakładka Info — sprawdzone pole po polu skryptem porównującym oba źródła.

**Tylko do odczytu, świadomie.** Info pozwala też zapisać producenta i numer klienta do
urządzenia; to operacja fabryczna, która nie ma czego szukać na karcie konfiguracji jazdy,
i zostaje tam, gdzie była.

Zakładka Info dostała `data-factory-tab="true"`, więc przełącznik ją teraz ukrywa.

**Uporządkowanie przy okazji:** cztery sekwencje odczytu przeniesione z `tab-info.js` do
`shared.js`, żeby obie karty czytały przez jedną definicję zamiast kopii. Kierunek
zależności ma znaczenie: `ui/js/evistdrive/` może sięgać do `shared.js`, ale **nigdy** do
karty fabrycznej.

Wiersze tabel są generowane z listy pól, a nie wypisane w `index.html` — 26 wierszy
niemal identycznych znaczników trzeba by inaczej ręcznie utrzymywać w zgodzie z listą pól.
Urządzenie, które nie odpowiada, pokazuje kreski zamiast zostawiać pustą kartę.

---

## Commity

```
52fc484 fix(ui): keep help bubbles inside the window and out of scrolling containers
9b5e13b feat(ui): device identification in the eVistDrive System card, and hide Info with the factory tabs
1022b7c feat(ui): put settings back — a Restore button per card and Shift+click per field
```

## Do sprawdzenia w realnym użyciu

- Dymki przy prawej krawędzi i w szerokich tabelach — czy widać cały tekst.
- „Restore" na karcie Profiles po odczycie banków — czy wraca do wartości z roweru.
- SHIFT + klik na pojedynczym polu — czy cofa tylko je.
- Przełącznik „pokaż tylko eVistDrive" — czy Info znika, a dane są w karcie System.
