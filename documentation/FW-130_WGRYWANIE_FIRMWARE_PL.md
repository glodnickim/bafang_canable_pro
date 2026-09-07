# FW-130 — wgrywanie firmware HMI: tempo ramek, twarde błędy i faza końcowa

Dotyczy `fw-updater.js` (tryb `HMI`, DPC245). Podstawa: analiza logu ze sniffowania
**udanego** wgrywania oficjalnym narzędziem BESST (42 377 linii, transfer 451,6 → 502,2 s,
60 833 chunki) oraz reverse firmware DPC245 po stronie projektu EVistDrive.

## 1. Co jest po naszej stronie, a co nie

Z obrazu stocku DPC245 wynika twardy podział ról — i on determinuje, co w ogóle da się
naprawić w tym narzędziu:

| krok | kto odpowiada |
|---|---|
| `85FF3005#00` announce | resident bootloader |
| **`85194000#08 42 03 xx`** | **aplikacja (APP) wyświetlacza** |
| `832A4000` ACK | bootloader — **już po resecie** |
| `85196008` → `832A6008#"DPBF81.0"` | bootloader |
| długość, wszystkie chunki, ACK-i blokowe, ACK końcowy | bootloader |
| keepalive `85FF3005#00` ~26 s + końcowe `01` | bootloader |

Dowody: ciąg `DPBF81.0` **nie występuje w pliku firmware** (ani w APP, ani w nagłówku
kontenera), a stała `0x3005` nie pojawia się w APP ani raz — aplikacja tej komendy nie zna.
Warunek wejścia w updater odzyskany z kodu APP (dekoder ramek `0x0801B26C`, gałąź
`0x0801B74A..0x0801B786`):

```text
dst == 3 (DISPLAY), op == 1, code == 0x40, sub == 0x00
DLC == 4, data[0..2] == 08 42 03        (src NIE jest sprawdzany)
```

po czym wołane jest `0x0801B240`: `cpsid i` → unlock flash → nadpisanie APP markera
`0x0803FFFE` wartością `00 00` → reset. **Funkcja nie wraca — APP nie wysyła żadnego ACK-a.**

Praktyczne wnioski:

- `832A4000` może przyjść **wyłącznie od bootloadera po reboocie**. Dlatego pętla
  `checkForControllerReady()`, która powtarza komendę co 60 ms aż do ACK-a, jest
  konstrukcyjnie poprawna i musi taka zostać;
- wszystko po tym kroku to kontrakt bootloader ↔ host. Zawieszenie „na 99 %" nie może
  zależeć od tego, jaki firmware był wcześniej we wyświetlaczu;
- **wyświetlacz, który po nieudanej próbie został ciemny, nie jest zepsuty** — ma
  nieważny APP marker, czyli siedzi w bootloaderze i czeka. Wystarczy powtórzyć wgrywanie;
- to samo tłumaczy raporty typu „dopiero po wgraniu oryginału poszło": druga sesja
  startowała z urządzeniem już w bootloaderze, więc krok zależny od APP w ogóle się nie
  wykonywał. Zawartość firmware nie miała z tym nic wspólnego.

## 2. Dlaczego pojedyncza zgubiona ramka jest niewidoczna

Protokół nie ma retransmisji. ACK blokowy `832A**02` potwierdza **pozycję**, nigdy nie
wskazuje dziury, a numer chunka jest zakodowany w ID (urządzenie zapisuje po adresie).
Zgubiona ramka przechodzi więc niezauważona przez cały transfer i ujawnia się dopiero
brakiem ACK-a końcowego — czyli jako zwis pod koniec.

Przy 60 833 ramkach i braku retransmisji potrzeba ok. sześciu dziewiątek niezawodności
ramki, żeby „prawie zawsze za pierwszym razem". Dlatego tempo nadawania nie może być
dobierane na oko.

## 3. Co zmieniono

### 3.1 Podłoga tempa zamiast ślepego opóźnienia (`MIN_FRAME_PERIOD_US = 810`)

Ramka 29-bit ID + 8 B to ~150 bitów po bit-stuffingu, czyli ~600 µs na magistrali
250 kbit/s. Oficjalne narzędzie utrzymuje ~810 µs/ramkę (60 833 ramki w 49,3 s).
Poprzednio było „poczekaj `delayUs` (domyślnie 300 µs) po każdej ramce", czyli realny okres
= 300 µs + nieznany czas wysyłki — nikt tego nie mierzył.

Teraz harmonogram jest **absolutny**: ramka *n* bieżącego odcinka jest należna w
`base + n × okres`. Wolniejsza wysyłka zjada własny zapas, a średni okres nie może zejść
poniżej podłogi. Po każdym oczekiwaniu na ACK blokowy harmonogram jest **resetowany**, żeby
martwy czas nie zamienił się w kredyt na serię wysłaną jednym ciągiem — bo to właśnie seria
przepełnia bufor nadawczy adaptera.

Ma to znaczenie, bo `writeCANFrame` sprawdza tylko `result.status === "ok"` z `transferOut`,
co potwierdza jedynie, że **USB** przyjęło transfer, a nie że ramka trafiła na CAN.
Przepełnienie FIFO w gs_usb nie zgłasza błędu, a echo TX jest wyłączone
(`echo_id = 0xFFFFFFFF`).

Pole na formularzu (`Time per frame`) działa nadal, ale wyłącznie **w górę**: wartości
poniżej podłogi są ignorowane. Domyślna wartość to teraz 810.

Do logu trafia zmierzona kadencja co 8192 chunki oraz średnia całkowita — porównywalna
wprost z 810 µs oficjalnego narzędzia. Koniec zgadywania.

### 3.2 Nieudana wysyłka przerywa wgrywanie

`sendRawFrameWithRetry()` po wyczerpaniu prób **rzuca wyjątkiem** zamiast cicho lecieć
dalej z dziurą w obrazie. Wyjątkiem jest pętla announce wołana z `retries = 0` — jej wolno
pominąć takt.

### 3.3 Sprawdzanie statusu w ACK-u końcowym

`832AEDA1` ma `DLC 4` i cztery bajty statusu (na udanym wgraniu same zera), podczas gdy
ACK-i blokowe mają DLC 0. To jedyny moment, w którym niekompletny obraz da się jeszcze
wykryć **zanim** wyświetlacz zacznie go zapisywać. Status inny niż zerowy = błąd wgrywania.

### 3.4 Faza końcowa zgodna z oryginałem

Oficjalne narzędzie po ACK-u końcowym:

```text
+196 ms    85FF3005#01
+1 s       85FF3005#00        (urządzenie odpowiada ..FF3005#01)
przez 26 s 85FF3005#00 co ~60 ms      <- wyświetlacz zapisuje własną pamięć
na koniec  85FF3005#01
```

Było: `delay(3000)` → `01` → `delay(2000)`, czyli całe okno zapisu zostawało poza sesją.
Teraz sekwencja jest odtworzona, a użytkownik dostaje w logu odliczanie i wyraźne
ostrzeżenie, żeby nie odłączać adaptera. Trzymanie sesji nie może zaszkodzić: APP nie zna
komendy `0x3005`, więc po restarcie do nowego firmware te ramki są po prostu ignorowane.

Okno jest konfigurowalne (`flashWriteWindowMs`, `flashWriteKeepaliveMs`) — wyłącznie po to,
żeby test mógł je skrócić.

### 3.5 Limit numeracji chunków

Numer chunka to cztery cyfry hex w ID, więc powyżej 65535 chunków (524 288 B payloadu)
numeracja zawija i koniec obrazu nadpisałby jego początek. Plik przekraczający ten limit
jest teraz odrzucany na wejściu. DPC245 (486 664 B / 60 833 chunki) mieści się z zapasem.

## 4. Test

`tests/fw130_updater_pacing_and_end_phase.js` (w `npm test`) uruchamia całą procedurę na
atrapie magistrali odpowiadającej jak DPC245 w trybie HMI i sprawdza: zmierzone tempo
(≥ podłoga, brak serii po ACK-ach), sekwencję fazy końcowej, odrzucenie obrazu przy
niezerowym statusie, przerwanie przy nieudanej wysyłce oraz limit numeracji. Bez sprzętu.

## 5. Co zostało niezrobione

- **Echo TX jako kontrola przepływu.** `echo_id = 0xFFFFFFFF` wyłącza potwierdzenia
  faktycznej transmisji, choć `canframe.js` już rozpoznaje ramki typu „echo". Włączenie
  echa i nadawanie „na potwierdzenie" domknęłoby pętlę strukturalnie, zamiast opierać się
  na odmierzonym czasie. To jest właściwy następny krok, jeśli po FW-130 zdarzy się jeszcze
  jedno wgrywanie stojące pod koniec;
- walidacja `DPBF81.0` z `85196008` względem wgrywanego pliku (dziś nic nie broni przed
  wgraniem firmware do niewłaściwego urządzenia);
- `chunksACKObject` / `chunksACKObjectplus1` rosną do ~60 tys. kluczy i nie są czyszczone;
- dopasowanie ACK-ów przez `idHex.includes()` na 7-znakowym wzorcu może teoretycznie trafić
  w cudze ID.
