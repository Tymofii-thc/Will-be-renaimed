# Proof of Deploy — контекст для Claude Code

Користувач пише українською, відповідай українською, коротко й прямо, без підлабузництва. Якщо він каже, що ти помилився, спочатку перевір, а не вибачайся одразу.

## Що це
Інструмент проти supply chain атак: після кожної збірки CI записує в Solana (Memo-програма) запис `pod1|<image>|<commit12>|<sha256 digest>|<ISO час>`. Перед деплоєм `oath verify` звіряє digest образу з цими записами і завершується з кодом 1, якщо запису нема. Власного смарт-контракту нема.

## Контекст
Це для хакатону Colosseum (Crypto World's Fair), дедлайн у вівторок 2026-10-13 близько 9:00 за варшавським часом (точну годину перевірити на формі сабміту). Користувач хоче не «іграшку», а реальний інструмент: підключається за кілька рядків і сам блокує деплой. Azure не використовуємо (дорого): GitHub Actions + GHCR + GitHub Pages.

## Структура
- `bin/oath.mjs` — CLI `oath verify --signer <pubkey> (--digest | --image | --container) [--rpc]`. Коди виходу: 0 перевірено, 1 не перевірено, 2 помилка. Залежностей нема.
- `scripts/anchor.mjs` — пише запис у Solana (потрібен `SOLANA_SECRET_KEY`, опційно `SOLANA_RPC`).
- `scripts/keygen.mjs` — генерує ключ CI і пробує devnet airdrop.
- `scripts/running-digest.sh` — digest образу, що реально працює в контейнері.
- `action.yml` — композитний GitHub Action (обгортка над anchor.mjs).
- `.github/workflows/deploy.yml` — build → anchor (через `uses: ./`) → deploy-job, який тягне образ і викликає `oath verify`. Потрібні секрет `SOLANA_SECRET_KEY` і змінна репозиторію `OATH_SIGNER` (публічний ключ).
- `verifier/index.html` — та сама перевірка в браузері (читає devnet RPC), для демо.
- `app/` — демо-сервіс і Dockerfile.

## Що перевірено
- Синтаксис усіх скриптів; YAML парситься.
- Збірка й підпис memo-транзакції офлайн.
- `oath verify` на локальному mock RPC: збіг, незбіг, невдала транзакція (ігнорується), немає signer, немає digest, RPC недоступний.
- Сторінка перевірки в Chromium на mock RPC (зелене/червоне).

## Що НЕ перевірено (робити першим)
- Реальний запис у Solana devnet (з середовища, де це писалось, мережа була недоступна) і airdrop.
- Повний прогін workflow на GitHub (GHCR, `uses: ./`, `npm ci` в action).
- Команда `npx github:Tymofii-thc/oath verify …` з README.
- `scripts/running-digest.sh` і `--image/--container` з реальним Docker.

## Далі
1. Прогнати кроки з README на реальному репозиторії, виправити, що впаде.
2. Підставити `<owner>` у README (зроблено: Tymofii-thc/oath).
3. Зняти демо на 3 хвилини за сценарієм з README, написати опис проєкту для форми сабміту.
4. Якщо лишиться час: admission-перевірка (блокування запуску без запису), мейннет через `--rpc`.
