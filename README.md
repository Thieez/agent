# Repo Terminal

Prosta aplikacja webowa do klonowania repozytoriów GitHub i pracy w interaktywnych terminalach w przeglądarce. Każda zakładka ma własny proces PTY, działający katalog roboczy oraz historię wyjścia; wejście, wyjście i zmianę rozmiaru terminala obsługuje WebSocket.

## Wymagane sekrety

- `APP_PASSWORD` — mocne hasło do strony, co najmniej 24 znaki.
- `GITHUB_TOKEN` — opcjonalny token konta do klonowania repozytoriów. Bez niego aplikacja działa, ale klonowanie jest niedostępne. Ogranicz go do potrzebnych repozytoriów i uprawnienia `Contents: Read-only`.

Token GitHub służy wyłącznie do klonowania repozytoriów i nie jest przekazywany do procesów terminala.
Wartość tokenu ustaw jako sekret `GITHUB_TOKEN` w konfiguracji usługi Render; aplikacja nie przyjmuje tokenów w formularzach ani nie zwraca ich do przeglądarki. Zalogowana strona pokazuje, czy token jest skonfigurowany i zaakceptowany przez GitHub, jego typ, nazwę konta oraz zakresy OAuth, jeśli GitHub je udostępnia. GitHub nie udostępnia przez API pełnej listy uprawnień tokenów fine-grained, więc dla nich strona wyraźnie zaznaczy, że szczegóły trzeba sprawdzić w ustawieniach tokenu. Aplikacja nie wyświetla innych sekretów środowiskowych.

## Terminale

Najpierw sklonuj repozytorium, a następnie utwórz jedną z maksymalnie 10 zakładek terminala, wybierając repozytorium. Każdy terminal uruchamia powłokę bezpośrednio w katalogu repozytorium; obsługuje interaktywne polecenia, Ctrl+C, zmianę rozmiaru oraz niezależne sesje. Zamknięcie zakładki kończy jej proces. Terminale i repozytoria znikają po wygaśnięciu sesji, restarcie lub wdrożeniu aplikacji.

## Wdrożenie na Render

Utwórz Web Service z tego repozytorium albo użyj dołączonego `render.yaml`. Konfiguracja używa `npm ci` do budowania, `npm start` do uruchamiania i `/healthz` jako health check. `node-pty` wymaga natywnego modułu, który jest budowany w czasie instalacji zależności. W ustawieniach usługi Render dodaj wymagane sekrety.

## Uruchomienie lokalne

Wymagany Node.js 22 lub nowszy, Git oraz narzędzia do budowania natywnych modułów `node-pty`. Ustaw `APP_PASSWORD` i `GITHUB_TOKEN`, a następnie uruchom:

```sh
npm ci
npm start
```

Aplikacja będzie dostępna pod `http://localhost:3000`.

## Ważne

Terminal udostępnia pełną powłokę i pozwala wykonywać dowolne polecenia w sklonowanym repozytorium. Używaj wyłącznie z zaufanymi repozytoriami i chroń hasło aplikacji. Sekrety serwera klonującego nie są przekazywane do terminala. Limit wynosi trzy repozytoria na sesję; klonowanie jest pojedynczym zadaniem.
