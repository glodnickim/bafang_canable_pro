# Budowanie pojedynczego pliku wykonywalnego

Aplikacja pakuje się do **jednego pliku `.exe`** (oraz binariów dla Linuksa
i macOS) narzędziem [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) — utrzymywanym
forkiem `pkg` Vercela, który został zarchiwizowany w 2024 r.

## Jak zbudować

```bash
npm install          # jednorazowo: dociąga @yao-pkg/pkg
npm run build:win    # tylko Windows x64 - najszybciej
npm run build        # wszystkie cele z pkg.targets
```

Wynik ląduje w `dist/`.

## Dlaczego jest osobny plik startowy `app.js`

`bin` w `package.json` wskazuje na `app.js`, a nie na `server.js`. Powód jest
jeden i twardy:

Moduł `usb` to **dodatek natywny**. System operacyjny potrafi załadować
bibliotekę wyłącznie z **prawdziwego pliku na dysku** — nie sięgnie do archiwum
zaszytego w `.exe`. Pojedynczy plik wykonywalny musi więc rozpakować tę jedną
bibliotekę, zanim cokolwiek załaduje `usb`.

`usb` szuka swojego pliku binarnego przez `node-gyp-build`, który najpierw
sprawdza zmienną `NODE_USB_PATH`
(`node_modules/usb/dist/usb/bindings.js`). `app.js` z tego korzysta:

1. wykrywa, że działa spakowany (`process.pkg`),
2. znajduje w archiwum prekompilowaną bibliotekę dla bieżącej platformy
   (`prebuilds/win32-x64/node.napi.node`, ~700 kB),
3. kopiuje ją do `%TEMP%\evistdrive-canable-native\prebuilds\<platforma>\`,
4. ustawia `NODE_USB_PATH` na ten katalog,
5. dopiero potem uruchamia `server.js`.

Kopiowanie odbywa się przy każdym starcie, ale plik o zgodnym rozmiarze nie jest
nadpisywany — normalne uruchomienie nic nie kosztuje. Uszkodzona kopia po
zabitym procesie zostanie podmieniona.

Uruchamianie ze źródeł (`npm run dev`) omija `app.js` w całości i działa jak
dotąd.

## Gdzie trafiają logi jazdy

Poza spakowaną wersją katalog `logs/` leży obok kodu. W `.exe` `__dirname`
wskazuje archiwum **tylko do odczytu**, więc `utils.js` przełącza się na katalog
**obok pliku wykonywalnego**:

```
eVistDrive.exe
logs\ride-2026-07-30-01.csv
```

Plik `.exe` musi zatem leżeć w katalogu z prawem zapisu — nie w `C:\Program Files`
bez podniesionych uprawnień.

## Czego `.exe` NIE załatwia

Sterownika USB dla adaptera CANable. Na Windowsie `libusb` wymaga, żeby do
urządzenia był podpięty **WinUSB** (zwykle przez Zadig). Na komputerze, gdzie
nigdy tego nie zrobiono, program wystartuje i pokaże interfejs, ale nie otworzy
adaptera. To krok niezależny od formy pakowania.

## Diagnostyka

| Objaw | Przyczyna |
|---|---|
| `Failed to unpack the USB driver binary` | katalog tymczasowy niezapisywalny albo blokada antywirusa |
| `no usb prebuild bundled for <platforma>` | budowa dla celu, dla którego moduł `usb` nie ma prekompilowanej biblioteki |
| interfejs działa, adapter niewidoczny | brak sterownika WinUSB (Zadig) |
| brak plików CSV z jazdy | `.exe` leży w katalogu bez prawa zapisu |

## Zależności, które wchodzą do paczki

- `ws`, `nanotimer`, `candlelightjs` — czysty JavaScript, bez niespodzianek,
- `usb` — jedyny dodatek natywny, obsłużony powyżej,
- `ui/**/*` — interfejs, serwowany z archiwum (tylko odczyt, to wystarcza).
