# CB-024 — moment w Nm, przełącznik limitu mocy i obwiednia limitów

- **Data:** 2026-08-07
- **Zakres:** wyłącznie aplikacja Canable (warstwa prezentacji). **Firmware nietknięty,
  protokół CAN nietknięty, format banku nietknięty.**
- **Dotyczy pól:** `max_iq_pct`, `max_motor_power_w`

## 1. Po co

Oba ustawienia były podawane w jednostkach, których nie da się poczuć na rowerze:

- `max_iq_pct` jako „procent limitu prądu fazowego sterownika" — nikt nie wie, ile to jest
  75%. Każdy wie, ile to 60 Nm.
- `max_motor_power_w` z etykietą **„Maximum motor power — 0 disables"**, co czyta się jako
  „0 wyłącza silnik". Naprawdę znaczy „brak dodatkowego limitu mocy" (firmware podstawia
  wtedy twardy sufit 1500 W). To był realny błąd opisu, nie tylko niezręczność.

## 2. Co widzi użytkownik

**Maximum motor torque** — suwak 0–80 Nm + pole liczbowe, pod spodem żywy podpis:

```
About 60 Nm · 75% of the phase-current limit
```

Przy 0: `Assist is switched off at this level.` (zgodne z firmware — `max_iq_pct == 0` jest
tam warunkiem „ten poziom nie wspomaga").

**Limit maximum motor power** — przełącznik. Wyłączony: `No extra power limit — only the
torque ceiling above applies.` Włączony: suwak + pole + `600 W ceiling once you are
spinning.`

Ostatnia niezerowa wartość jest pamiętana **wyłącznie w stanie UI** (`Map` w `common.js`),
osobno dla każdego banku i poziomu. Nie trafia do profilu ani na wire — na wire jest jedno
pole i 0 **jest** wyłączeniem limitu.

## 3. Wykres

Zastąpiony `renderLimitsChart`. Dwa panele obok siebie, oś X = kadencja korby 0–120 rpm:

- **lewy:** szacowany moment [Nm] — sufit z `max_iq_pct` (linia odniesienia) i moment
  faktycznie dostępny po uwzględnieniu limitu mocy;
- **prawy:** szacowana moc elektryczna [W] — rośnie, dopóki ogranicza moment, potem płaskie
  plateau na ustawionym limicie.

Pionowa linia pokazuje **kadencję, przy której limit mocy przejmuje pałeczkę** — to jedyna
liczba na tym wykresie, na którą użytkownik może zareagować.

Poprzednia wersja rysowała oba sufity względem „how hard you push" w W i %. Ta oś była
wymyślona: nacisk nie przekłada się na żaden z tych limitów, a panel w procentach nie mówił
nic, co da się poczuć. Kadencja jest tu prawdziwą zmienną niezależną, bo to `P = M × ω`
sprawia, że oba limity zamieniają się miejscami.

## 4. Czego wykres NIE robi

Nie udaje charakterystyki silnika. Nie ma sztucznego wzrostu momentu poniżej 50 rpm ani
spadku przy wysokiej kadencji — **nie mamy danych z hamowni ani mapy producenta M820**.
Rysowana jest obwiednia limitów wynikająca z ustawień, i tyle. Podpis pod wykresem mówi to
wprost.

## 5. Uczciwość liczby 80 Nm

`max_iq_pct` to procent **limitu prądu fazowego sterownika**, nie momentu znamionowego
silnika. Moment jest w PMSM praktycznie proporcjonalny do prądu, więc skalowanie liniowe jest
poprawne — ale „100% = 80 Nm" obowiązuje tylko wtedy, gdy limit prądu fazowego sterownika
odpowiada prądowi, przy którym M820 daje swoje znamionowe 80 Nm. Przy niżej ustawionym
limicie 100% to mniej niż 80 Nm.

Dlatego wszędzie jest napisane **„szacowany"**, a dymek pola mówi o tym wprost. Nie jest to
pomiar.

## 6. Pliki

| Plik | Zmiana |
|---|---|
| `ui/js/evistdrive/motor-limits.js` | NOWY — czyste funkcje: `iqPercentToTorqueNm`, `torqueNmToIqPercent`, `calculateMotorLimitPoint`, `buildMotorLimitSeries`. Bez importów, bez DOM, bez stanu |
| `ui/js/evistdrive/common.js` | suwak w `fieldInput` (rAF), żywy podpis `note()`, nowy typ `toggleValue` z pamięcią ostatniej wartości |
| `ui/js/evistdrive/profiles.js` | oba deskryptory pól przepisane |
| `ui/js/evistdrive/engine-preview-ui.js` | `renderLimitsChart` przepisany na dwa panele względem kadencji |
| `ui/js/evistdrive/presets.js` | **poprawka błędu zastanego**, patrz niżej |
| `ui/style.css` | `.ebics-slider` (zwykły CSS, nie Tailwind — nie wymaga `build:css`) |
| `tests/cb024_motor_limits.js` | NOWY — testy na prawdziwym module ESM |

## 7. Błąd zastany naprawiony przy okazji

`clampInto()` w imporcie presetów porównywał **wartość natywną** z **granicami w jednostkach
wyświetlania**. Skutek: preset z `emtb_reference_voltage_mv = 36000` był „naprawiany" do 84
(maksimum w woltach), a `curve_exponent_x10 = 15` do 2,5. Użytkownik dostawał komunikat, że
wartość była poza zakresem i została skorygowana — po czym miał zepsuty profil.

Poprawka: granice są tłumaczone **do jednostki zapisu** (`toNative(min)`, `toNative(max)`) i
porównanie odbywa się tam. Wszystkie używane konwersje są monotoniczne, więc przeliczenie obu
końców jest dokładne i nie kwantyzuje wartości, która i tak była poprawna.

Świadomie NIE zrobiłem tego przez „przelicz do wyświetlania, obetnij, przelicz z powrotem":
`fromNative` pola momentu samo obcina, więc wartość spoza zakresu (np. 250%) wyglądałaby po
przeliczeniu na poprawną i przeszłaby nietknięta. Test to sprawdza.

## 8. Do ręcznego sprawdzenia w przeglądarce

- [ ] przeciąganie suwaka momentu odświeża podpis i oba wykresy płynnie, bez zacinania
- [ ] przełącznik mocy: wyłącz → włącz przywraca poprzednią wartość, nie 600 W
- [ ] przełączanie poziomów i banków nie miesza zapamiętanych wartości między nimi
- [ ] Shift+klik na polu liczbowym mocy przywraca wartość i poprawnie ustawia przełącznik
- [ ] „Copy to…" w sekcji Power and current ceiling nadal kopiuje oba pola
- [ ] import presetu z inną mocą/momentem wchodzi bez komunikatu o obcięciu
- [ ] po Write + Save to Flash odczyt banku zwraca dokładnie te same wartości
