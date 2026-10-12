# Proof of Deploy

Інструмент, який не дає запустити в проді образ, що не збирав ваш пайплайн.

**Проблема.** Підмінений образ у реєстрі, ручний `docker push` у обхід CI, скомпрометований токен: ніхто не помітить, що в проді працює не те, що зібрали. Це supply chain атака.

**Рішення.** Кожна збірка записує в Solana незмінний запис `коміт → digest → час` (стандартна Memo-програма, власного смарт-контракту нема). Перед деплоєм `pod verify` звіряє digest образу з цими записами і **зупиняє деплой**, якщо запису нема.

```
build ──► image digest ──► Solana Memo tx (підпис CI-ключа)
                                  │
deploy ──► docker pull ──► pod verify ──► ✔ exit 0  → деплой іде
                                         ✘ exit 1  → деплой зупинено
```

## Підключення за 3 кроки

**1. Ключ CI** (один раз):
```bash
npm install
node scripts/keygen.mjs      # друкує public + secret key і пробує devnet airdrop
```
Додай у репозиторій: секрет `SOLANA_SECRET_KEY` (secret key), змінну `POD_SIGNER` (public key). SOL для devnet: https://faucet.solana.com

**2. Запис після збірки** (у вашому workflow):
```yaml
- uses: Tymofii-thc/Will-be-renaimed@main
  with:
    image: ghcr.io/${{ github.repository }}
    digest: ${{ steps.build.outputs.digest }}
    secret-key: ${{ secrets.SOLANA_SECRET_KEY }}
```

**3. Перевірка перед деплоєм:**
```yaml
- run: docker pull ghcr.io/${{ github.repository }}:latest
- run: npx --yes github:Tymofii-thc/Will-be-renaimed verify --signer "${{ vars.POD_SIGNER }}" --image ghcr.io/${{ github.repository }}:latest
```
Цей репозиторій уже використовує сам себе так: див. `.github/workflows/deploy.yml`.

## CLI
```bash
node bin/pod.mjs verify --signer <pubkey> --digest sha256:…
node bin/pod.mjs verify --signer <pubkey> --image ghcr.io/me/app:latest
node bin/pod.mjs verify --signer <pubkey> --container prod      # образ, що ЗАРАЗ працює
```
Коди виходу: `0` перевірено, `1` не перевірено, `2` помилка (мережа, аргументи). Для мейннету додай `--rpc <url>` або змінну `SOLANA_RPC` (і те саме для кроку 2 через вхід `rpc`).

`verifier/index.html` це та сама перевірка у браузері, для демо й для людей, які не лізуть у термінал.

## Сценарій демо (3 хвилини)
1. **Проблема** (20 с): «Як довести, що в проді те, що зібрав пайплайн?»
2. **Нормальний деплой** (40 с): push → збірка → запис у Solana (показати транзакцію в Explorer) → `pod verify` дає VERIFIED → деплой іде.
3. **Атака** (60 с): вручну збираєш інший образ і пушиш у той самий тег в обхід CI. Запускаєш workflow вручну (Run workflow) для кроку deploy або локально `docker pull` + `pod verify`: **NOT VERIFIED, exit 1, деплой зупинено.**
4. **Чому блокчейн** (30 с): запис не перепише ані CI-адмін, ані зловмисник із доступом до реєстру.
5. **Далі** (30 с): Kubernetes admission controller, мейннет, ротація й апаратні ключі.

Для кроку 3: запуск workflow вручну (`workflow_dispatch`) перезбирає образ і створює новий запис, тож для чистої демонстрації атаки роби її локально: `docker build` + `docker push` у тег `:latest`, а потім `pod verify --image …:latest`.

## Обмеження (скажи сам, перш ніж запитають)
- За замовчуванням devnet. Для реального використання потрібен мейннет (кілька копійок за запис).
- Безпека тримається на секретності CI-ключа: хто його вкраде, може записати фальшивий digest. Далі потрібні апаратні ключі або підпис через Sigstore.
- Перевірка зараз стоїть у CI-кроці. Для захисту самого кластера потрібен admission controller.
- Запис доводить походження образу, а не його безпеку: сканер вразливостей він не замінює.
- Аналог без блокчейну: Sigstore/Rekor. Наша відмінність у тому, що журнал публічний і не залежить від одного оператора.
- Кінець-в-кінець тест на живому devnet ще не проганявся: логіка перевірена на підставленому RPC.
