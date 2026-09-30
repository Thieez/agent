# Copilot Repo

Prosta aplikacja webowa do klonowania repozytoriów GitHub i uruchamiania zadań przez GitHub Copilot CLI. Logi i statusy są przesyłane przez WebSocket.

## Wymagane sekrety

- `APP_PASSWORD` — mocne hasło do strony, co najmniej 24 znaki.
- `GITHUB_TOKEN` — token konta, z którego klonujesz repozytoria. Ogranicz go do potrzebnych repozytoriów i uprawnienia `Contents: Read-only`.
- `COPILOT_GITHUB_TOKEN` — opcjonalny token Copilot; można go też wpisać na stronie agenta.

Token Copilot można wpisać na stronie agenta zamiast logowania kodem urządzenia. Obsługiwane są tokeny OAuth (`gho_`), fine-grained PAT (`github_pat_`) z uprawnieniem konta **Copilot Requests** oraz token GitHub App (`ghu_`). CLI użyje tokenu przy kolejnych zadaniach. Token wpisany na stronie jest przechowywany wyłącznie w pamięci procesu i trzeba go podać ponownie po restarcie lub wdrożeniu; nie jest zwracany do przeglądarki ani zapisywany w logu. Można też nadal używać **Zaloguj Copilot przez GitHub**. `GITHUB_TOKEN` służy wyłącznie do klonowania repozytoriów i jest odrębnym tokenem.

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

Logowanie OAuth Copilot i sklonowane repozytoria są przechowywane tylko w tymczasowym systemie plików procesu. Po restarcie lub wdrożeniu Rendera zaloguj Copilot ponownie; sesje repozytoriów również mogą zniknąć. Limit wynosi trzy repozytoria na sesję, a jednocześnie działa jedno zadanie Git lub Copilot CLI.