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

## 2026-08-25 — jak w Canable wywołać odbiór zamierzonych wartości (test FW-126)?

**Pytanie:** „do jak z canablem mam wywołac odbiór zamierzonych wartości?"

**Odpowiedź:** dane z testu FW-126 przychodzą dwiema różnymi drogami i to jest właśnie to,
czego UI wcześniej nie tłumaczyło:

- **pomiar zbocza CH3** (ramki `0x10240–0x10246`) sterownik nadaje **sam z siebie**, ale tylko
  w podsumowaniu sesji — czyli dopiero **~3 s po tym, jak jazda ucichnie**. Nie ma czego
  „wywoływać"; trzeba dać rowerowi zamilknąć i nie wyłączać zasilania. Dodatkowo cały pomiar
  uzbraja się **raz na cykl zasilania**, przy pierwszym starcie wspomagania.
- **dump kalibracji `0x602D`** sterownik wysyła **wyłącznie na żądanie**. Wcześniej nie było
  czym o niego zapytać — w aplikacji nie istniało takie polecenie.

**Co zmieniliśmy w aplikacji:** w zakładce **Sniffer** doszedł panel **FW-126 TEST** (read-only):

- ramki `0x10240–0x10246` łapie **pasywnie i niezależnie od filtrów** — preset ukrywający je
  w widoku na żywo już nie zagłodzi pomiaru (wcześniej filtr widoku decydował o tym, co widać,
  i łatwo było pomyśleć, że nic nie przyszło);
- przycisk **Read CAL 0x602D** wysyła dokładnie jedną ramkę odczytu (`0511602D`, EFF, DLC 0) —
  panel nie potrafi wysłać nic innego i nie ma w nim żadnego zapisu;
- przycisk **Get FW-126 Result** robi obie rzeczy naraz: analizuje już odebrane ramki CH3,
  dociąga dump i pokazuje wynik końcowy;
- **Copy FW-126 Report** kopiuje gotowy tekst do wklejenia;
- w panelu jest napisane wprost, kiedy dane przychodzą („sweep arms once per power cycle at the
  first assist start; its result arrives with the session summary, ~3 s after the ride goes
  quiet"), więc nie trzeba tego pamiętać.

Surowy log jest nietknięty — panel jest **dodatkiem**, nie zamiennikiem loggera. Nadal warto
zaznaczyć **Log to file**, bo plik zawiera każdą ramkę i to on jest materiałem dowodowym.

**Lekcja do instrukcji:** jeśli jakieś dane przychodzą tylko po żądaniu, w UI musi istnieć
przycisk, który to żądanie wysyła. A jeśli przychodzą same, ale z opóźnieniem albo tylko raz na
cykl zasilania, UI musi to powiedzieć — inaczej użytkownik uzna, że sprzęt nie działa.

---

## 2026-09-03 — po zdjęciu filtrów moc „zjeżdża" między naciśnięciami, a zębatka i tak kręci się 1-2 s

**Pytanie:** „pozdejmowalem filtry i podanie zaczyna się od razu kiedy noga przestaje podawać
nacisk na pedał, i zanim kolejna naciśnie to czuję że tam moc zjeżdża. Ile trwa i co powoduje
który mechanizm, że zębatka po najmocniejszym naciśnięciu i zatrzymaniu od razu pedałowania,
zanim zatrzyma się na 0, będzie się kręcić coraz wolniej ale przez 1-2 s?"

**Krótka odpowiedź: to są DWA różne zjawiska, w dwóch różnych warstwach.**

### A. Moc zjeżdża między naciśnięciami — to filtr RUN, nie rampa

Korba ma dwa suwy mocy na obrót, więc obciążenie na czujniku pulsuje: dwa dołki na obrót,
w martwych punktach. Przy 60 rpm pełny obrót trwa 1000 ms, więc dołek wypada co 500 ms i sam
trwa ~110-150 ms.

`TORQUE_RUN_ASYM_FALL_MS = 0` (zdjęty filtr) oznacza, że żądanie kopiuje sygnał czujnika w tym
samym ticku — przepuszcza tętno nogi 1:1. Zmierzone na własnym harnessie firmware'u
(`tests/host/torque/torque_run_asym_host.c`, scenariusz S5, tętno międzyszczytowe RUN w
jednostkach native; 27 native ≈ 1 kg):

| cadence | FALL=0 (teraz) | 100 ms | 150 ms | 200 ms | 250 ms | 350 ms (przed) |
|---|---|---|---|---|---|---|
| 20 rpm | **142** (5,3 kg) | 110 | 97 | 85 | 76 | 62 |
| 40 rpm | **126** (4,7 kg) | 97 | 84 | 75 | 67 | 55 |
| 60 rpm | **106** (3,9 kg) | 73 | 61 | 52 | 46 | 38 |
| 80 rpm | **89** (3,3 kg) | 55 | 45 | 39 | 34 | 28 |

Sam czujnik po filtrze FAST (35 ms) ma tętno 122-148 native, więc przy FALL=0 do napędu idzie
73-96 % tego tętna. Test S5 ma granicę 100 native i **dziś ją przekracza** — firmware sam
zgłasza to, co czuć na rowerze.

Rampa opadania (`Deceleration` / `iq_fall`) tego nie ratuje, bo jest liczona jako **pełna skala
prądu na czas**: spadek z 25 % skali przy poziomie 3 i 22 km/h zajmuje 0,25 × 125 ms = **31 ms**,
czyli prąd dochodzi do podłogi 3-4 razy szybciej, niż trwa dołek korby. Podłoga min-Iq to
domyślnie **2 %** (`Current floor`) — technicznie trzyma, praktycznie nie czuć.

Koszt filtra po drugiej stronie: filtr jest wykładniczy o stałej czasowej równej ustawionym ms,
a przy dokładnym zerze żądania dostaje snap. Zjazd z pełnej wartości do zera ≈ 4 × ustawienie:

| FALL_MS | tętno @60 rpm | zjazd po odpuszczeniu nacisku |
|---|---|---|
| 0 | 106 (najgorzej) | natychmiast |
| 150 | 61 | ~0,6 s |
| 200 | 52 | ~0,8 s |
| 350 | 38 (najlepiej) | ~1,4 s ← to była skarga „ciągnie po puszczeniu" |

**Ważne:** ten filtr **nie wydłuża zatrzymania**. Kiedy pedałowanie ustaje, żądanie jest zerowane
w tym samym ticku inną drogą (`pedaling_active` = false), więc filtr dotyczy wyłącznie
zmniejszania nacisku PRZY dalszym pedałowaniu. Kompromis 150-200 ms leży między dołkiem korby
(110-150 ms) a świadomym odpuszczeniem (sekundy) — dlatego da się je rozdzielić.

### B. Zębatka kręci się 1-2 s — to NIE jest żaden timer firmware'u

Rozpisane po ticku, dla najmocniejszego naciśnięcia z 70 rpm na poziomie 3 (~70 % skali prądu):

| czas | co się dzieje | mechanizm |
|---|---|---|
| 0 | noga schodzi z pedału | — |
| ~35-70 ms | żądanie mocy spada do 0 | filtr FAST 35 ms (RUN nie tłumi, FALL=0) |
| ~120-160 ms | **prąd wspomagania jest już na podłodze** | rampa `iq_fall`: 0,7 × 125 ms = 88 ms |
| do ~200 ms | podłoga 2 % | `Current floor` + hold `Sustain` |
| ~200 ms | wykryte „przestał pedałować", bramka się zamyka, cel = 0 | `PAS_STOP_TICKS` = 800 ticków @4 kHz |
| + `release_ms` | zjazd tych 2 % do zera | tryb RELEASE (u Ciebie w banku — sprawdź, czy 650 czy 100 ms) |
| < 7,5 rpm zębatki | wymuszone dokładne zero | FW-048 coast release (10 erps) |
| **potem** | **nic nie hamuje wirnika** | ← tu jest te 1-2 s |

Sumarycznie firmware podaje realny moment przez ~0,15 s, potem najwyżej 2 % przez ~0,2-0,7 s.
Reszta to **swobodny wybieg**: przy zerowym zadanym prądzie regulator PI ustawia napięcie mostka
dokładnie równe napięciu generowanemu przez kręcący się silnik (`u_q ≈ BEMF`), więc przez
uzwojenia nie płynie prąd, nie ma momentu hamującego, a wirnik z przekładnią zwalnia tylko na
tarciu. Zębatka jest przy tym ciągnięta przez sprzęgło jednokierunkowe tak długo, jak strona
silnika jest szybsza — dlatego widać, że kręci się coraz wolniej. Przy 70 rpm korby silnik ma
~800 obr/min (przekładnia 11,43:1), więc jest co wytracać.

To dokładnie ten sam mechanizm, który karta **QZERO** naprawia (fade całek PI 10 ms po dojściu
Iq_ref do 0), i dlatego zdjęcie filtrów nic tu nie zmieniło — filtry działają w warstwie
żądania, a wybieg jest w warstwie regulatora prądu.

**Wnioski praktyczne, którymi da się to rozdzielić:**
* tętno między suwami → wygładzanie opadania RUN. **KOREKTA (2026-09-03):** to NIE jest pokrętło
  w aplikacji. Pole `RUN torque smoothing` jest w stopniach korby i działa tylko jako włącznik
  (0 = filtr wyłączony); same milisekundy to stała kompilacji `TORQUE_RUN_ASYM_FALL_MS`, więc
  zmiana wymaga wgrania firmware. Wdrożona wartość domyślna: **250 ms** — najszybszy zjazd, przy
  którym wszystkie testy zachowania firmware'u są zielone (175 -> 2 błędy, 225 -> 1, 250 -> 0),
  tętno  rpm spada z 106 na 46 native, koszt przy odpuszczaniu nacisku ~1,0 s zamiast ~1,4 s;
* alternatywnie/dodatkowo `Current floor` z 2 % na 20-40 % przy skróconym `Sustain` do ~300 ms —
  podłoga podtrzyma dołek, a krótki hold nie zostawi ogona po zatrzymaniu;
* długość wybiegu zębatki → tylko QZERO (build B), żadne ustawienie w Canable tego nie dotyka.

**Poprawka w UI (do zrobienia — wynika wprost z tego pytania):**
1. `RUN torque smoothing` jest opisany w stopniach korby, a **liczba stopni nie robi dziś nic** —
   pole działa jak włącznik (0 = bez filtra, ≠ 0 = filtr 120 ms w górę / 350 ms w dół). Opis i
   jednostka są wprost mylące; zamienić na milisekundy opadania i dopisać w dymku, że pole NIE
   wpływa na czas zatrzymania po zaprzestaniu pedałowania.
2. `Deceleration` (Ramp Down) w dymku obiecuje „jak szybko wspomaganie zanika". W praktyce
   rządzi tylko spadkami W TRAKCIE pedałowania (m.in. dołkami korby); zanik po zaprzestaniu
   pedałowania to `Release duration`. Rozdzielić te dwa zdania w dymkach obu pól.
3. `Current floor` = 2 % nie ma opisu, do czego służy (podtrzymanie w martwym punkcie korby).
   Dopisać to zdanie i wskazać, że działa razem z `Sustain`.

---

## Do dopisania przy kolejnych pytaniach

- [ ] czy `Release duration` = 0 (AUTO) jest dla użytkownika zrozumiałe bez czytania dymka?
- [ ] czy widać różnicę między `Minimum pedal load` a `Minimum pedal load while riding`?
- [x] czy `RUN torque smoothing` jako pole GLOBALNE (nie per poziom) jest oczywiste? -> NIE, i gorzej: jednostka (stopnie) nie odpowiada dzialaniu, patrz wpis 2026-09-03
