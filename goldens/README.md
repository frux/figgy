# Golden fixtures

Golden-файл хранит сырой tool result официального Figma MCP, а не ответ агента
после пересказа. Сейчас поддерживается `get_metadata`:

```json
{
  "schemaVersion": 1,
  "tool": "get_metadata",
  "request": {
    "nodeId": "12:34"
  },
  "response": {
    "content": [
      {
        "type": "text",
        "text": "<frame id=\"12:34\" name=\"Example\" ... />"
      }
    ]
  },
  "provenance": {
    "capturedAt": "2026-08-31T12:00:00Z",
    "figmaMcpVersion": "record the version when observable",
    "sourceFileSha256": "sha256 of the exact .fig file",
    "note": "optional capture context"
  }
}
```

Допустимые поля `request`:

- `nodeId` — отсутствие означает запрос списка страниц;
- `maxDepth` — расширение figgy для ограниченного дерева;
- `includeImplementationInstruction` — учитывать ли служебное напоминание.

Проверка:

```bash
figgy verify /path/to/exact-source.fig ./goldens/example.get_metadata.json
```

Приватные файлы кладите в `goldens/private/`: каталог игнорируется Git. Не
коммитьте клиентские названия, тексты, изображения и MCP-ответы без явного
разрешения владельца макета.
