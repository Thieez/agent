# Repo Terminal

Prosta aplikacja webowa do klonowania repozytoriów GitHub i pracy w interaktywnych terminalach w przeglądarce. Każda zakładka ma własny proces PTY, działający katalog roboczy oraz historię wyjścia; wejście, wyjście i zmianę rozmiaru terminala obsługuje WebSocket.

## Wymagane sekrety

- `APP_PASSWORD` — mocne hasło do strony, co najmniej 24 znaki.
- `GITHUB_TOKEN` — opcjonalny token konta do klonowania repozytoriów. Możesz dodać wiele kont, ustawiając kolejne sekrety, np. `GITHUB_TOKEN_WORK` i `GITHUB_TOKEN_PERSONAL`. Bez tokenu aplikacja działa, ale klonowanie jest niedostępne.

Tokeny GitHub ustaw jako sekrety środowiskowe usługi Render; aplikacja nie przyjmuje ich na stronie ani nie zwraca wartości do przeglądarki. Nazwy zgodne ze wzorcem `GITHUB_TOKEN` lub `GITHUB_TOKEN_NAZWA` są wykrywane automatycznie. Zalogowana strona pokazuje listę tokenów i przypisanych do nich kont, a osobno jedną zbiorczą listę dostępnych repozytoriów z informacją, przez które tokeny są dostępne. Każde widoczne repozytorium można sklonować przy użyciu powiązanego z nim tokenu. GitHub nie udostępnia przez API pełnej listy uprawnień fine-grained tokenu — dostępne repozytoria i uprawnienia do nich są natomiast weryfikowane przez API. Token klonowania nie jest przekazywany do procesów terminala; wyjątkiem jest wybrany osobno token Copilot opisany poniżej.

## Terminale

Utwórz jedną z maksymalnie 10 zakładek terminala, wybierając sklonowane repozytorium albo katalog aplikacji, aby uruchomić terminal bez klonowania. Opcjonalnie przypisz token Copilot. W terminalu z wybranym tokenem uruchom `copilot`; CLI używa tokenu przypisanego wyłącznie do tej zakładki, więc inne terminale mogą korzystać z innych kont. Każdy terminal obsługuje interaktywne polecenia, Ctrl+C oraz zmianę rozmiaru. Zamknięcie zakładki kończy jej proces. Terminale i repozytoria znikają po wygaśnięciu sesji, restarcie lub wdrożeniu aplikacji.

Komendy instalacji narzędzi terminala są konfigurowane w `terminalDependencies` pliku `config.json` i uruchamiane przy każdym starcie przez `npm start`. Komendy są wykonywane w katalogu projektu; GitHub CLI ma osobną komendę dla Linux i Windows.

Wybrany token Copilot jest dostępny jako `COPILOT_GITHUB_TOKEN` wewnątrz powłoki tego terminala, aby CLI mogło się nim uwierzytelnić. Ponieważ terminal udostępnia pełną powłokę, uruchamiane w nim polecenia mogą odczytać ten token. Pozostałe tokeny środowiskowe nie są przekazywane do terminala.

## Wdrożenie na Render

Utwórz Web Service z tego repozytorium albo użyj dołączonego `render.yaml`. Konfiguracja używa `npm ci` do budowania, `npm start` do uruchamiania i `/healthz` jako health check. `node-pty` wymaga natywnego modułu, który jest budowany w czasie instalacji zależności. W ustawieniach usługi Render dodaj `APP_PASSWORD` oraz sekrety GitHub/Copilot.

## Uruchomienie lokalne

Wymagany Node.js 22 lub nowszy, Git oraz narzędzia do budowania natywnych modułów `node-pty`. Ustaw `APP_PASSWORD` i opcjonalnie jeden lub więcej tokenów `GITHUB_TOKEN` / `GITHUB_TOKEN_NAZWA`, a następnie uruchom:

```sh
npm ci
npm start
```

Aplikacja będzie dostępna pod `http://localhost:3000`.

## Ważne

Terminal udostępnia pełną powłokę i pozwala wykonywać dowolne polecenia w sklonowanym repozytorium. Używaj wyłącznie z zaufanymi repozytoriami i chroń hasło aplikacji. Sekrety serwera klonującego nie są przekazywane do terminala. Limit wynosi trzy repozytoria na sesję; klonowanie jest pojedynczym zadaniem.
