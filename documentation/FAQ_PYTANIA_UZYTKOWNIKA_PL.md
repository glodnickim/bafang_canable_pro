# FAQ — pytania użytkownika o konfigurację i zachowanie ustawień w Canable

**Do czego to jest:** surowy materiał na instrukcję dla użytkownika. Zapisujemy tu każde
pytanie właściciela o to, co dane ustawienie robi, dlaczego zachowuje się tak a nie inaczej
i skąd się biorą jego zakresy. Zasada, która to uruchomiła:

> „Ja będę takim pierwszym eksperymentem. Jeśli ja nie wiem, inni też nie będą wiedzieć."

Każde pytanie zadane na żywo jest dowodem, że UI samo z siebie czegoś nie tłumaczy. Dlatego
przy każdej pozycji notujemy nie tylko odpowiedź, ale też **co zmieniliśmy w aplikacji**, żeby
następna osoba nie musiała pytać.

**Co tu NIE trafia:** pytania o błędy, które naprawiliśmy w tej samej rozmowie. Użytkownik
nigdy na nie nie trafi, a w instrukcji byłyby tylko szumem. Zostają pytania typu „jak to
działa" i „którym pokrętłem to się kręci" — te są aktualne niezależnie od wersji.

**Format wpisu:** data, pytanie (jak padło), krótka odpowiedź, poprawka w UI, nazwy pól po
angielsku (tak jak w aplikacji), żeby dało się to potem przetłumaczyć na instrukcję.

---

## 2026-08-06 — co odpowiada za przyrost wspomagania, a co za jego szybki spadek?

**Pytanie:** „co odpowiada za przyrost i szybkie opadanie wspomagania? Przyrost na wyższym
poziomie chciałbym trochę wydłużyć, bo to jest zbyt agresywne — napęd bardzo dostaje w kość
przy takich pikach. I bardziej interesuje mnie, co odpowiada za szybkie zmniejszanie mocy,
jak noga zaczyna mniej przyciskać, a kręci."

**Odpowiedź — przyrost** (oba per poziom, zakładka Profiles):

| Ustawienie | Karta | Domyślnie | Rola |
|---|---|---:|---|
| `Power rise filter` | Power smoothing and release | 150 ms | wygładza wzrost ŻĄDANIA mocy — ścina szpic mocnego naciśnięcia |
| `Acceleration — low / high` | Current ramps | 600 / 300 ms | ogranicza TEMPO narastania prądu 0→100% |

Do złagodzenia agresywnych pików w jeździe: najpierw `Power rise filter` (150 → 300 ms), potem
`Acceleration — high` (300 → 450 ms). Po jednej zmianie na jazdę, na wybranych poziomach.

**Odpowiedź — spadek przy kręceniu.** Najważniejsze: `Release duration` tutaj **nie działa** —
ona rusza dopiero, gdy korba się zatrzyma. Przy kręceniu działa łańcuch:

1. `RUN torque smoothing (anti-pulse)` — zakładka Dynamics, **globalne**, 180° (pół obrotu);
2. `Power fall filter` — per poziom, 375 ms;
3. `Deceleration — high` — per poziom, **140 ms** — zwykle to on odpowiada za „moc znika, jak
   tylko przestanę mocno pchać". To najkrótsza rampa na rowerze i w jeździe to ona obowiązuje.

Kolejność strojenia: `Deceleration — high` (140 → 250–350 ms), potem `Power fall filter`
(375 → 500–600 ms). `RUN torque smoothing` na końcu i ostrożnie — jest globalne i działa w obie
strony: większe okno wygładza spadek, ale opóźnia też reakcję na dodanie nacisku.

**Lekcja do instrukcji:** trzeba wprost napisać, że `Release duration` dotyczy WYŁĄCZNIE
sytuacji po zatrzymaniu korby. Nazwa sugeruje „zwalnianie nacisku", a to zupełnie co innego.

---

## 2026-08-06 — co to jest „low", a co „high" cadence dla Acceleration?

**Pytanie:** „możesz dodać na wykresach lub opisach w Canable, jaki to jest low, a jaki high
cadence dla acceleration?"

**Odpowiedź:** To są sztywne progi w firmware (`config.h`), których aplikacja nie odczytuje ze
sterownika — dlatego nigdzie ich nie było:

- **wolna** rampa: ≤ **4,0 km/h** ORAZ ≤ **20 obr/min**
- **szybka** rampa: ≥ **20,0 km/h** LUB ≥ **70 obr/min**
- pomiędzy — płynne mieszanie

Firmware liczy czas rampy **osobno z prędkości i osobno z kadencji, a potem bierze krótszy
wynik**. Czyli wystarczy, że JEDNO z dwojga jest „wysokie": 70 obr/min na miejscu rozpędza tak
samo jak 20 km/h. W praktyce w jeździe prawie zawsze rządzi wartość **high**. Ruszanie z
miejsca zawsze bierze wartość **low** — więc podnosząc tylko `Acceleration — high` nie rusza
się charakteru startu.

**Co zmieniliśmy:** progi trafiły wprost do etykiet pól (`Acceleration — high speed/cadence
(≥ 20 km/h or ≥ 70 rpm)`), do dymków oraz do legendy i podpisu wykresu ramp. Liczby są w
jednym miejscu (`ui/js/evistdrive/common.js`) z komentarzem, że lustrzą `config.h`.

**Lekcja do instrukcji:** każde pole opisane słowem względnym („low", „high", „slow", „fast")
musi podawać liczbę, przy której ta wartość zaczyna obowiązywać. Inaczej nie da się go
świadomie ustawić.

---

## Do dopisania przy kolejnych pytaniach

- [ ] czy `Release duration` = 0 (AUTO) jest dla użytkownika zrozumiałe bez czytania dymka?
- [ ] czy widać różnicę między `Minimum pedal load` a `Minimum pedal load while riding`?
- [ ] czy `RUN torque smoothing` jako pole GLOBALNE (nie per poziom) jest oczywiste?
