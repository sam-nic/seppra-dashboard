# Подключение ручной синхронизации

Эти файлы нужно добавить в корень репозитория `seppra-dashboard`, сохранив структуру папок.

## 1. Загрузить файлы в GitHub

После загрузки в репозитории должны появиться:

```text
call-center-kpi/index.html
config.js
worker/package.json
worker/wrangler.jsonc
worker/src/index.js
```

`call-center-kpi/index.html` заменяет существующий файл.

## 2. Вернуться в Cloudflare

На экране **Set up your application**:

- Project name: `seppra-planfix-proxy`
- Build command: оставить пустым
- Deploy command: `npx wrangler deploy`

Открыть **Advanced settings** и указать:

- Root directory: `worker`
- Production branch: `main`

После этого нажать **Deploy**.

## 3. Добавить секрет Planfix

После создания Worker открыть:

**Workers & Pages → seppra-planfix-proxy → Settings → Variables and Secrets**

Добавить:

- Type: Secret
- Name: `PLANFIX_TOKEN`
- Value: действующий токен Planfix

Сохранить и выполнить повторный Deploy, если Cloudflare предложит.

## 4. Записать адрес Worker

Cloudflare покажет URL примерно такого вида:

```text
https://seppra-planfix-proxy.<ваш-поддомен>.workers.dev
```

Открыть в GitHub файл `config.js` и заменить:

```js
window.PLANFIX_PROXY_URL = 'https://REPLACE-ME.workers.dev';
```

на фактический URL Worker.

## 5. Проверка

1. Дождаться обновления GitHub Pages.
2. Войти в дашборд через Firebase.
3. Открыть отчёт колл-центра.
4. Нажать ручную синхронизацию.

Токен Planfix хранится только в Cloudflare Secret и не передаётся браузеру.
