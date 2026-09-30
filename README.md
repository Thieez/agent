# Copilot Repo

Prosta aplikacja webowa do klonowania repozytoriów GitHub i uruchamiania zadań przez GitHub Copilot CLI. Logi i statusy są przesyłane przez WebSocket.

## Wymagane sekrety

- `APP_PASSWORD` — mocne hasło do strony, co najmniej 24 znaki.
- `GITHUB_TOKEN` — token konta, z którego klonujesz repozytoria. Ogranicz go do potrzebnych repozytoriów i uprawnienia `Contents: Read-only`.
- `COPILOT_GITHUB_TOKEN` — opcjonalny token Copilot, który zostanie dodany do listy po uruchomieniu.

Dodaj tokeny Copilot w panelu i nadaj im nazwy. Obsługiwane są tokeny OAuth (`gho_`), fine-grained PAT (`github_pat_`) z uprawnieniem konta **Copilot Requests** oraz token GitHub App (`ghu_`). Lista pokazuje tylko nazwy i zamaskowane końcówki. Token można edytować (puste pole zachowuje poprzedni sekret) lub usunąć. Tokeny dodane w panelu są przechowywane wyłącznie w pamięci procesu i trzeba je dodać ponownie po restarcie lub wdrożeniu; zmienna `COPILOT_GITHUB_TOKEN` jest opcjonalnym sposobem załadowania jednego tokenu przy starcie. Sekrety nie są zwracane do przeglądarki ani zapisywane w logu. `GITHUB_TOKEN` służy wyłącznie do klonowania repozytoriów i jest odrębnym tokenem.

Utwórz osobny chat, wybierając repozytorium i token. Każdy chat zachowuje osobny kontekst CLI i można uruchamiać do czterech zadań równolegle. Równoczesne zadania muszą używać różnych repozytoriów, aby nie nadpisywać sobie zmian. Można utworzyć maksymalnie 10 tokenów i 10 chatów na sesję.

## Wdrożenie na Render

Utwórz Web Service z tego repozytorium albo użyj dołączonego `render.yaml`. Konfiguracja używa `npm ci` do budowania, `npm start` do uruchamiania i `/healthz` jako health check. W ustawieniach usługi Render dodaj wymagane sekrety.

## Uruchomienie lokalne

Wymagany Node.js 22 lub nowszy i Git. Ustaw `APP_PASSWORD` i `GITHUB_TOKEN`, a następnie uruchom:

```sh
npm ci
npm start
```

Aplikacja będzie dostępna pod `http://localhost:3000`.

## Ważne

Copilot CLI uruchamia się z `--allow-all-tools`, żeby móc wykonywać zadania bez interaktywnego zatwierdzania w przeglądarce. Może czytać i modyfikować pliki repozytorium oraz uruchamiać polecenia — używaj wyłącznie z zaufanymi repozytoriami. Chroń hasło i token klonowania, nadaj mu minimalne uprawnienia i nie wystawiaj aplikacji bez ochrony dostępu.

Tokeny, czaty i sklonowane repozytoria są przechowywane tylko w pamięci lub tymczasowym systemie plików procesu. Po restarcie lub wdrożeniu Rendera trzeba dodać tokeny ponownie, a repozytoria i czaty znikną. Limit wynosi trzy repozytoria na sesję; klonowanie jest pojedynczym zadaniem, niezależnym od maksymalnie czterech równoległych zadań Copilot.