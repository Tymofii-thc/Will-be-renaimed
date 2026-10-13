# Proof of Deploy — контекст для Claude Code

Користувач пише українською, відповідай українською, коротко й прямо, без підлабузництва. Якщо він каже, що ти помилився, спочатку перевір, а не вибачайся одразу.

## Що це
Інструмент проти supply chain атак: після кожної збірки CI записує в Solana (Memo-програма) запис `pod1|<image>|<commit12>|<sha256 digest>|<ISO час>`. Перед деплоєм `oath verify` звіряє digest образу з цими записами і завершується з кодом 1, якщо запису нема. Власного смарт-контракту нема.

## Контекст
Це для хакатону Colosseum (Crypto World's Fair), дедлайн у вівторок 2026-10-13 близько 9:00 за варшавським часом (точну годину перевірити на формі сабміту). Користувач хоче не «іграшку», а реальний інструмент: підключається за кілька рядків і сам блокує деплой. Azure не використовуємо (дорого): GitHub Actions + GHCR + GitHub Pages.

## Структура
- `bin/oath.mjs`: CLI `oath init|verify|audit` (`--signer a,b`, `--network`, `--rpc`, `--max-age`, `--quorum`, `--attest owner/repo`, `--no-bind`). Коди виходу: 0 перевірено, 1 не перевірено, 2 помилка.
- `lib/`: `oath.mjs` (пошук запису, кворум, пагінація), `registry.mjs` (тег → digest), `admission.mjs` (логіка webhook), `attest.mjs` (Sigstore/SLSA), `audit.mjs` (`oath audit`).
- `bin/oath-webhook.mjs` + `deploy/` (`install.sh`, `k8s/oath.yaml`): Kubernetes mutating admission webhook (pin тегу в digest, fail closed).
- `scripts/anchor.mjs` пише запис у Solana (Memo), `scripts/keygen.mjs` генерує ключ, `action.yml` композитний GitHub Action (запис), `verify/action.yml` (перевірка перед деплоєм).
- `.github/workflows/`: `deploy.yml` (build → attest → anchor → deploy, Trivy за `OATH_SCAN`), `release-webhook.yml`, `pages.yml`, `anchor-mainnet.yml` (ручний).
- `verifier/`: статичний сайт (index.html, style.css, app.js, assets/), деплоїться на GitHub Pages: https://tymofii-thc.github.io/oath/
- `test/`: юніт-тести (`npm test`) і `e2e-kind.sh`. `demo/demo.sh`: сценарій демо. `app/`: демо-сервіс.
- Формат запису `pod1|<image>|<commit12>|<digest>|<ISO час>` лишився від старої назви; не міняти, бо зламає наявні записи.

## Що перевірено (наживо)
- Запис і перевірка на Solana devnet; кворум із двома ключами; `--attest` на справжній атестації нашого CI (і негативні кейси).
- Docker: `--image`, `--container`, `running-digest.sh`. Kubernetes (kind): допуск, pin, відмова, блокування Deployment, fail-closed (`test/e2e-kind.sh`), `oath audit`.
- GitHub Actions: збірка → GHCR → атестація → запис → перевірка → деплой; `npx --allow-git=all github:Tymofii-thc/oath verify`.
- Сайт: jsdom проти живого devnet (обидві мови), Firefox headless (світла/темна тема, 390px).

## Що НЕ перевірено / не зроблено
- Мейннет у CI (код підтримує; ручний workflow `anchor-mainnet`, потрібен баланс SOL).
- Підпис Ledger/апаратним гаманцем (не реалізовано).
- `--attest` для приватних репозиторіїв (приватні реєстри в webhook перевірено: реєстр із паролем + мок Bearer).
- Сайт у справжньому Chrome/Safari і на телефоні.

## Далі
Відео демо (3 хв, сценарій у README), презентація, опис для форми сабміту. Далі за часом: мейннет у CI, перевірка атестацій у webhook для приватних реєстрів.
