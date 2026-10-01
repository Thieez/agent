# Repo Agent

Repo Agent udostępnia chronione hasłem terminale przeglądarkowe uruchamiane bezpośrednio w repozytorium `gup`. Każdy terminal startuje PowerShell z załadowanym `gup.ps1`, więc polecenia i obsługa konfiguracji pochodzą z gup, a nie z osobnej logiki klonowania w aplikacji. Terminale używają xterm i WebSocket; limit to 10 terminali na sesję.

## Wymagania

- Node.js 22 lub nowszy, Git i narzędzia do budowania natywnych modułów `node-pty`.
- PowerShell: Windows PowerShell (`powershell.exe`) w Windows lub PowerShell 7 (`pwsh`) w Linux.
- `APP_PASSWORD` — hasło aplikacji o długości co najmniej 24 znaków.

## Build

```sh
npm ci
npm run build
npm start
```

`npm run build` klonuje najnowszą wersję domyślnej gałęzi `Tomasz-Gziut/gup` do katalogu `gup` obok aplikacji. Jeśli repozytorium jest już sklonowane, build aktualizuje je przez `git pull --ff-only`. Jeżeli obok Repo Agent znajduje się plik `.env`, build kopiuje go do katalogu sklonowanego gup; na Linuxie ustawia uprawnienia pliku na `0600`. Katalog `gup` jest artefaktem buildu i nie jest częścią repozytorium Repo Agent.

Można wskazać inny checkout zmienną `GUP_ROOT`; domyślnie aplikacja używa `gup` sklonowanego w trakcie buildu.

## Konfiguracja gup

Repo Agent nie obsługuje repozytoriów ani tokenów GitHub samodzielnie. Terminal otrzymuje środowisko procesu (z wyjątkiem `APP_PASSWORD`), a `gup.ps1` korzysta z własnej konfiguracji: pliku `.env` przekazanego podczas buildu, zmiennych środowiskowych lub uwierzytelnienia GitHub CLI. Instalacja narzędzi terminala z `config.json` zapewnia CLI używane przez komendy gup.

Terminal udostępnia pełną powłokę. Użytkownicy znający hasło aplikacji mogą uruchamiać dowolne polecenia i odczytać sekrety przekazane terminalowi, w tym tokeny `GITHUB_TOKEN`. Ustawiaj silne hasło i używaj tej usługi tylko z zaufanymi użytkownikami.

## Wdrożenie na Render

Utwórz Web Service z repozytorium Repo Agent lub użyj dołączonego `render.yaml`. Build wykonuje `npm ci` i `npm run build`; start uruchamia `npm start`, a health check korzysta z `/healthz`. Ustaw `APP_PASSWORD` jako sekret środowiskowy. W razie potrzeby skonfiguruj tokeny GitHub jako zmienne środowiskowe używane przez gup. Linuxowy obraz usługi musi mieć PowerShell 7 (`pwsh`); bez niego terminal nie wystartuje.

## Testy

```sh
npm test
```
