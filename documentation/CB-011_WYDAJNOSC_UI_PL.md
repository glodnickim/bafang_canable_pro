# CB-011 — Wydajność interfejsu: czarny selektor i obciążony procesor

Stan: **WDROŻONE** (2026-07-30). Potwierdzenie w realnym użyciu **oczekuje**.

---

## Problem odczuwany w użyciu

Rozwinięcie listy trybów albo banków pokazywało przez chwilę czarne, puste okienko.
Komputer wyraźnie się męczył — najbardziej widoczne przy pracy na baterii.

## Przyczyna

Plik `ui/tailwind.js` (271 KB) nie zawierał gotowych stylów. Był to
**`@tailwindcss/browser@4.2.2` — kompilator CSS działający w przeglądarce**, który
twórcy Tailwinda opisują jako przeznaczony wyłącznie do rozwoju, nigdy na produkcję.

Powód jest w jego środku: zakłada nasłuch na **każdą zmianę w dokumencie** i po każdej
przelicza wszystkie reguły od nowa — w kodzie dosłownie
`MutationObserver(() => rebuild("full"))`. Do przeliczenia miał 1612 elementów i 672
atrybuty klas.

Drugie ostrze: przy płynącej telemetrii **każda ramka CAN odświeżała ponad 20 pól**
tekstowych na kartach Live i System. Każde odświeżenie to zmiana w dokumencie. Czyli
każda ramka z roweru wywoływała pełne przeliczenie CSS całej strony.

Dropdown był czarny, bo system prosił przeglądarkę o narysowanie listy, a ta liczyła
style. Na baterii procesor dodatkowo zwalnia, stąd nasilenie objawu.

## Rozwiązanie

1. **CSS generowany raz, przy budowaniu.** `npm run build:css` tworzy
   `ui/tailwind.built.css` (17,5 KB) i **ten plik jest w repozytorium**, więc
   uruchomienie ze źródeł nie wymaga żadnego kroku budowania. Kompilator usunięty ze
   strony.
2. **Zapis do pola tylko przy realnej zmianie.** `safeSetText` i `setText` porównują
   przed przypisaniem; wskaźnik nacisku zaokrągla szerokość do pełnych procent.
   Większość wartości telemetrii (temperatury, pojemność, dystans, bank, tryb) jest
   identyczna klatka po klatce.

**Zachowanie wyglądu:** arkusz jest wpięty **po** `style.css`, bo kompilator dopisywał
swój `<style>` na końcu `<head>`. Ta sama kolejność kaskady = ten sam wygląd. Pokrycie
sprawdzone po wygenerowaniu — wszystkie klasy użyte w znacznikach i w kodzie budującym
DOM, łącznie z wariantami `sm:` i `file:`.

> **PUŁAPKA NA PRZYSZŁOŚĆ.** Po dodaniu **nowej klasy Tailwinda** do `ui/index.html`
> albo do kodu JS budującego DOM trzeba uruchomić `npm run build:css`. Klasa, której
> generator nie zobaczył, **nie wytworzy żadnej reguły** i element po prostu nie
> dostanie stylu. Wcześniej kompilator w przeglądarce załatwiał to sam.
>
> Nie dotyczy klas własnych projektu (`.btn-save`, `.ebics-field`, …) — te żyją
> w `ui/style.css` i nic nie trzeba przebudowywać.

---

## Znaleziska z przeglądu kodu, naprawione tym samym zamachem

| # | Rzecz | Naprawa |
|---|---|---|
| 1 | `fw-updater.js` zakładał nasłuch ramek i **nigdy go nie zdejmował**, jako funkcję anonimową (nie do usunięcia później). Każda próba wgrania dokładała kolejny na stałe | `cleanup()` w `finally`, jak w `logger.js` i `sniffer.js` |
| 2 | `addLog` rósł bez żadnego limitu; każdy wpis wymuszał przeliczenie układu | ostatnie 500 wpisów |
| 3 | Druga kopia programu wywalała się z `EADDRINUSE` i śladem stosu | mówi „już działam" i otwiera przeglądarkę |
| 4 | Plotly: pełna paczka 3,5 MB, a używane są tylko `scatter` i `bar` | wariant `basic` 1 MB, pokrycie sprawdzone przed zamianą |
| 5 | Wykresy Profiles i Dynamics rysowały się, gdy karta była niewidoczna | rysują tylko gdy widoczne |
| 6 | Strona nie wracała po zerwaniu połączenia z serwerem | czeka na serwer i przeładowuje się sama |
| 7 | `btn-orange` / `btn-red` / `btn-blue` użyte na 19 przyciskach, **nigdzie niezdefiniowane** | dodane do `style.css` |
| 8 | `ui/main.js` — 215 KB martwego kodu sprzed podziału na moduły | usunięty |

**Punkt 3 zasługuje na uwagę.** Pierwsza wersja poprawki nie działała: biblioteka `ws`
przechwytuje błąd serwera HTTP i przerzuca go na siebie, więc obsługa tylko na `server`
nadal kończyła się wysypką. Wykrył to test, nie przegląd kodu. Obsługa jest teraz na obu
emiterach.

**Punkt 6 domyka CB-010.** Bez niego serwer podnosił adapter po uśpieniu, ale karta w
przeglądarce zostawała martwa i nigdy by się o tym nie dowiedziała.

**Punkt 7 nie był regresją.** Te przyciski renderowały się bez koloru od zawsze —
kompilator w przeglądarce też nie potrafił wygenerować reguły dla nazwy, która nie jest
klasą narzędziową Tailwinda.

## Bilans wagi strony

| | Przed | Po |
|---|---|---|
| Plotly | 3,5 MB | 1,0 MB |
| Tailwind | 271 KB kompilatora, liczącego przy każdej zmianie DOM | 17,5 KB gotowego CSS |
| Martwy `main.js` | 215 KB w `.exe` | — |

## Commity

```
a5fcc82 perf(ui): compile Tailwind at build time instead of in the browser
269f5c5 perf+fix(ui,server): stop the leaks, cap the log, survive a restart, halve the payload
a61df58 style(ui): give the eVistDrive write buttons their intended colours, drop the pre-split monolith
```

## Do potwierdzenia w realnym użyciu

Rozwinięcie listy trybów/banków przy podłączonym rowerze i płynącej telemetrii, na
baterii. Objaw ma zniknąć. Jeśli nie zniknie — następnym krokiem jest nagranie profilera
w przeglądarce (zakładka Performance, 10 s przy płynącej telemetrii), które wskaże
prawdziwego winowajcę zamiast hipotezy.
