# Changelog

Заметки к каждому релизу публикуются в описании [GitHub Release](https://github.com/0xQ71/AFKLLM/releases),
полный текст лежит в [`docs/releases/`](docs/releases/).

## 0.5.0-20261123

Qwen3.8-Flash-Next на Strata (256K, по умолчанию на ПК с 64 ГБ), подготовка ПК одной командой, хуки как в
Claude Code для DeepSeek Harness, ярлыки на рабочем столе.

Подробно: [`docs/releases/v0.5.0-20261123.md`](docs/releases/v0.5.0-20261123.md).

- Хуки для DeepSeek Harness (плагин `harness/dsh-hooks-afkllm`, `/hooks`): защита от разрушительных команд,
  проверка синтаксиса после каждой правки, проверка перед концом хода с возвратом агента к сломанным файлам или
  упавшим тестам, уведомление Windows после долгого хода, свои `PreToolUse` / `PostToolUse` / `Stop` в формате
  Claude Code (`~/.dsh/hooks.json`, `<проект>/.dsh/hooks.json` после `/hooks trust`).
- Навыки агента `security-review` и `test`.
- Профиль `flash`: Qwen3.8-Flash-Next IQ3_XXS (MoE, 47 ГБ весов) на движке [Strata](https://github.com/Niko1221/Strata)
  для ПК с 64 ГБ ОЗУ: родной контекст 256K, 55–85 t/s и 750–1850 t/s чтения промпта против 18,5 и 300 у llama.cpp
  на тех же файлах, мышление xhigh до 32K на шаг с сэмплингом из карточки модели.
  Работает через тот же `afk api` (прокси, смена модели, GPU-своп для картинок), есть в профиле DeepSeek Harness.
  Разовая настройка: `scripts\strata-setup.cmd`.
- Модель по умолчанию выбирается по железу: `flash` на ПК с 64 ГБ ОЗУ и настроенной Strata, иначе `q38`
  (`defaultProfile` в `~/.afkllm/cli.json` закрепляет выбор).
- `scripts\setup.cmd`: подготовка ПК одной командой — проверка железа и рекомендация модели, загрузка с докачкой и
  проверкой SHA-256 (`download-models.py --flash`), установка Strata и пресета, профиль DeepSeek Harness, ярлыки.
- Ярлыки на рабочем столе: «AFKLLM — запустить», «AFKLLM — остановить модель», «AFKLLM — выключить всё».
- `scripts\afk-stop.cmd`: одной кнопкой остановить модель, прокси, ComfyUI и DeepSeek Harness и освободить VRAM.
- Правила агента: обе модели, и обход ограничения песочницы Harness на временные папки Python 3.13.
- Окно модели (`afk-llama.ps1`) показывает работу Strata по-русски; Ctrl+C останавливает модель вместе с дочерними
  процессами.

## 0.4.0-20261114

Headless-ядро агента и три входа в него: CLI `afk`, бэкенд `afk api` (OpenAI `/v1` + MCP + поиск) для DeepSeek
Harness и других клиентов, Desktop-приложение на том же ядре. Генерация изображений Qwen-Image 2.1 с GPU-свопом,
профиль Qwen3.8 27B + MTP на 104K для 16 ГБ, готовый профиль DeepSeek Harness, бенчмарки моделей.

Подробно: [`docs/releases/v0.4.0-20261114.md`](docs/releases/v0.4.0-20261114.md).
