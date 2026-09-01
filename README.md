# figgy

`figgy` — локальная CLI для чтения и рендера экспортированных файлов Figma
(`.fig`), а также воспроизведения ответов read-only инструментов официального
Figma MCP.

Проект находится на ранней стадии. Уже работает полный вертикальный срез для
`get_metadata`: контейнер `.fig` → встроенная Kiwi-схема → дерево узлов →
разреженный XML → MCP `content[]`. Форма ответа откалибрована по настоящему
ответу официального MCP; вычисляемая геометрия сложных групп и закрытая
эвристика Figma `isAsset` пока остаются зонами частичного, а не полного паритета.

## Что уже работает

- современные `.fig` как ZIP-архивы, включая ZIP data descriptors;
- старые файлы, начинающиеся непосредственно с `fig-kiwi`;
- встроенные Kiwi-схемы: файл декодируется своей схемой, без жёсткой привязки к
  одной версии формата;
- deflate и zstd payload;
- восстановление и поиск дерева по Figma GUID (`sessionID:localID`);
- скрытие internal-only canvas и консервативное сворачивание векторных ассетов;
- axis-aligned размеры узлов с учётом локальной transform-матрицы;
- `inspect` для быстрой диагностики файла;
- `get-metadata` / `get_metadata` с обычным текстовым выводом либо MCP-envelope;
- локальный `render` страницы или отдельного узла в PNG/SVG;
- `verify` для сравнения с сохранённым ответом настоящего Figma MCP.

## Установка и запуск

Требуются Node.js 20 или новее и npm.

```bash
npm install
npm run build
node dist/cli.js --help
```

Во время разработки CLI можно запускать без предварительной сборки:

```bash
npm run dev -- inspect /path/to/layout.fig
npm run dev -- get-metadata /path/to/layout.fig
npm run dev -- get-metadata /path/to/layout.fig --node 12:34
npm run dev -- get-metadata /path/to/layout.fig --node 12-34 --format mcp
npm run dev -- render /path/to/layout.fig --output /tmp/layout.png
```

После глобальной установки или `npm link` команда называется `figgy`:

```bash
figgy inspect ./layout.fig
figgy get-metadata ./layout.fig --node 12:34 --depth 3
figgy render ./layout.fig --node 12:34 --output ./frame.png
```

Без `--node` команда возвращает список страниц. `--node` принимает как
канонический `12:34`, так и URL-вариант `12-34`. `--depth 0` оставляет только
выбранный узел, не раскрывая потомков.

## Локальный рендер

Без `--node` и `--page` команда рендерит первую страницу. Узел выбирается по
Figma GUID, а страница — по точному имени или id:

```bash
figgy render ./layout.fig --output ./page.png
figgy render ./layout.fig --page "Main" --format svg --output ./page.svg
figgy render ./layout.fig --node 12-34 --scale 2 --output ./card@2x.png
```

Поддерживаемые форматы первого среза — PNG и SVG. Формат выводится из расширения
`--output`, если `--format` не задан. PNG по умолчанию вписывается в сторону
4096 px и общий лимит 4096×4096 пикселей; фактический масштаб, ширина и высота
возвращаются в JSON-результате команды. Лимит стороны можно уменьшить через
`--max-dimension`. Существующий файл не перезаписывается без `--force`.

Рендер выполняется headless-движком OpenPencil: он восстанавливает SceneGraph,
встроенные изображения, векторную геометрию, paints, masks, effects и текст, а
PNG растеризуется локальным CanvasKit. Это уже полезный локальный preview, но
пиксельный паритет с официальным Figma MCP `get_screenshot` ещё не измерен.

Все сетевые источники шрифтов принудительно отключены. Это исключает утечку
названий шрифтов и текстовых подмножеств из NDA-макета, однако отсутствующий
локально шрифт будет заменён встроенным fallback и может изменить метрики текста.
PNG и особенно SVG сами содержат данные макета и должны обрабатываться как такие
же приватные артефакты, что и исходный `.fig`.

## Проверка совместимости

Сохраните сырой MCP tool result официального `get_metadata` в golden-файл по
схеме из [`goldens/README.md`](goldens/README.md), затем выполните:

```bash
figgy verify ./layout.fig ./goldens/layout.frame.get_metadata.json
```

Коды завершения:

- `0` — локальный MCP-envelope совпал с эталоном;
- `1` — файл, аргументы или golden некорректны;
- `2` — сравнение выполнено, но найдено расхождение.

`verify` сообщает путь к первому отличию, например
`$.content[0].text`. Переносы строк CRLF/LF нормализуются; содержательные поля
не «подчищаются», чтобы несовместимость не скрывалась.

## Что означает «такой же ответ»

Цель разбита на четыре проверяемых уровня:

1. **Transport parity** — те же типы MCP content blocks и ошибки.
2. **Structural parity** — те же узлы, порядок, свойства и форма ответа.
3. **Semantic parity** — эквивалентные layout, typography, paints, variables и
   component semantics.
4. **Visual parity** — screenshot/assets сравниваются пиксельно либо с явно
   заданным порогом.

Побайтовое равенство не всегда осмысленно: официальный `get_design_context`
по умолчанию генерирует React + Tailwind, а asset URL могут быть временными.
Такие поля будут нормализоваться только явно и только после того, как реальный
golden подтвердит их недетерминированность. Полная матрица находится в
[`docs/compatibility.md`](docs/compatibility.md).

## Архитектура

```text
.fig
  └─ archive.ts       ZIP/legacy container, lazy archive entry reads
      └─ decoder.ts   fig-kiwi framing, deflate/zstd, embedded schema
          └─ model.ts node changes → indexed tree
              ├─ compatibility/metadata.ts
              ├─ inspect.ts
              └─ golden.ts

.fig
  └─ render.ts        OpenPencil FIG import → SceneGraph
      ├─ SVG export   local vector output
      └─ CanvasKit    local PNG rasterization
```

Транспорт специально отделён от модели. После стабилизации контрактов поверх
тех же функций можно добавить stdio MCP server, не дублируя декодер и
совместимость.

## Разработка

```bash
npm run check
npm run test:coverage
```

Тестовый `.fig` генерируется актуальным `@open-pencil/kiwi` во время теста. Отдельный
интеграционный fixture формирует ZIP с data descriptors, поэтому тесты не
зависят от приватных макетов или установленной Figma.

Формат `.fig` закрыт и официально не документирован. Реализация использует
встроенную в файл Kiwi-схему и опирается на открытый формат
[Kiwi](https://github.com/evanw/kiwi). Актуальный набор и назначение MCP tools
описаны в [официальной документации Figma](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/).

## Приватные макеты

Файлы `.fig`, каталог `for-tests/` и `goldens/private/` игнорируются Git.
Публикуемый npm-пакет дополнительно ограничен allowlist-полем `files` и содержит
только `dist/`, `README.md` и `LICENSE`. Перед релизом это следует перепроверять
через `npm pack --dry-run --json`.

Нельзя коммитить сырые официальные MCP-ответы: XML содержит названия слоёв и
прочие данные макета. Для приватной калибровки храните их только в
`goldens/private/` либо используйте временный in-memory diff.

Отрендеренные PNG/SVG также являются производными приватного макета. Вывод по
умолчанию создаётся рядом с исходным `.fig`, поэтому для файлов внутри
`for-tests/` он автоматически остаётся под игнором всего каталога. При явном
`--output` ответственность за безопасный путь лежит на вызывающей стороне.

## Следующий необходимый вход

Для расширения профиля нужны дополнительные синхронизированные пары `.fig` и
сырых ответов официального Figma MCP для того же состояния файла:

- `get_metadata`;
- `get_variable_defs`;
- `get_screenshot`;
- `get_design_context` с зафиксированными `clientLanguages` и
  `clientFrameworks`.

В репозиторий следует добавлять только специально подготовленные обезличенные
фикстуры. Для геометрических golden-тестов важно, чтобы локальный экспорт и
облачный запрос относились к одной версии макета.
