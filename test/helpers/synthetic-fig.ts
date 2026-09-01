import { deflateRawSync } from "node:zlib";
import {
  compileSchema,
  encodeBinarySchema,
  parseSchema,
} from "@open-pencil/kiwi";

const SYNTHETIC_SCHEMA = `
enum NodeType {
  DOCUMENT = 0;
  CANVAS = 1;
  FRAME = 2;
  TEXT = 3;
  VECTOR = 4;
  BOOLEAN_OPERATION = 5;
}

struct Guid {
  int sessionID;
  int localID;
}

struct Vector {
  float x;
  float y;
}

struct Transform {
  float m00;
  float m01;
  float m02;
  float m10;
  float m11;
  float m12;
}

message ParentIndex {
  Guid guid = 1;
  string position = 2;
}

message NodeChange {
  Guid guid = 1;
  ParentIndex parentIndex = 2;
  NodeType type = 3;
  string name = 4;
  Vector size = 5;
  Transform transform = 6;
  bool visible = 7;
}

message Message {
  NodeChange[] nodeChanges = 1;
}
`;

interface SyntheticNode {
  id: [number, number];
  parent?: [number, number];
  type:
    | "DOCUMENT"
    | "CANVAS"
    | "FRAME"
    | "TEXT"
    | "VECTOR"
    | "BOOLEAN_OPERATION";
  name: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: boolean;
  transform?: Partial<{
    m00: number;
    m01: number;
    m02: number;
    m10: number;
    m11: number;
    m12: number;
  }>;
}

const DEFAULT_NODES: SyntheticNode[] = [
  { id: [0, 0], type: "DOCUMENT", name: "Document" },
  {
    id: [0, 1],
    parent: [0, 0],
    type: "CANVAS",
    name: "Main & states",
  },
  {
    id: [1, 2],
    parent: [0, 1],
    type: "FRAME",
    name: 'Hero "wide"',
    x: 12.5,
    y: 24,
    width: 320,
    height: 200,
  },
  {
    id: [1, 3],
    parent: [1, 2],
    type: "TEXT",
    name: "Title <h1>",
    x: 16,
    y: 20,
    width: 120,
    height: 24,
    visible: false,
  },
];

function rawNode(node: SyntheticNode): Record<string, unknown> {
  const [sessionID, localID] = node.id;
  const parent = node.parent
    ? {
        guid: { sessionID: node.parent[0], localID: node.parent[1] },
        position: `${localID}`,
      }
    : undefined;
  const hasSize = node.width !== undefined || node.height !== undefined;
  const hasTransform =
    node.x !== undefined || node.y !== undefined || node.transform !== undefined;
  return {
    guid: { sessionID, localID },
    type: node.type,
    name: node.name,
    ...(parent ? { parentIndex: parent } : {}),
    ...(hasSize
      ? { size: { x: node.width ?? 0, y: node.height ?? 0 } }
      : {}),
    ...(hasTransform
      ? {
          transform: {
            m00: node.transform?.m00 ?? 1,
            m01: node.transform?.m01 ?? 0,
            m02: node.transform?.m02 ?? node.x ?? 0,
            m10: node.transform?.m10 ?? 0,
            m11: node.transform?.m11 ?? 1,
            m12: node.transform?.m12 ?? node.y ?? 0,
          },
        }
      : {}),
    ...(node.visible !== undefined ? { visible: node.visible } : {}),
  };
}

export function syntheticCanvas(
  nodes: readonly SyntheticNode[] = DEFAULT_NODES,
): Buffer {
  const schema = parseSchema(SYNTHETIC_SCHEMA);
  const compiled = compileSchema(schema) as {
    encodeMessage(value: unknown): Uint8Array;
  };
  const schemaCompressed = deflateRawSync(encodeBinarySchema(schema));
  const messageCompressed = deflateRawSync(
    compiled.encodeMessage({ nodeChanges: nodes.map(rawNode) }),
  );

  const header = Buffer.alloc(16);
  header.write("fig-kiwi", 0, "ascii");
  header.writeUInt32LE(101, 8);
  header.writeUInt32LE(schemaCompressed.length, 12);
  const messageLength = Buffer.alloc(4);
  messageLength.writeUInt32LE(messageCompressed.length, 0);
  return Buffer.concat([
    header,
    schemaCompressed,
    messageLength,
    messageCompressed,
  ]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntryParts {
  local: Buffer;
  central: Buffer;
}

function zipEntry(name: string, content: Buffer, offset: number): ZipEntryParts {
  const nameBytes = Buffer.from(name, "utf8");
  const checksum = crc32(content);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x08, 6); // Sizes follow in a data descriptor.
  localHeader.writeUInt16LE(0, 8); // Stored, not compressed.
  localHeader.writeUInt16LE(nameBytes.length, 26);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(checksum, 4);
  descriptor.writeUInt32LE(content.length, 8);
  descriptor.writeUInt32LE(content.length, 12);
  const local = Buffer.concat([localHeader, nameBytes, content, descriptor]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x08, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(content.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt32LE(offset, 42);
  const central = Buffer.concat([centralHeader, nameBytes]);
  return { local, central };
}

export function syntheticFigArchive(): Buffer {
  const inputs: Array<[string, Buffer]> = [
    ["canvas.fig", syntheticCanvas()],
    ["meta.json", Buffer.from('{"name":"Synthetic fixture"}', "utf8")],
    ["images/", Buffer.alloc(0)],
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const [name, content] of inputs) {
    const entry = zipEntry(name, content, localOffset);
    locals.push(entry.local);
    centrals.push(entry.central);
    localOffset += entry.local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(inputs.length, 8);
  end.writeUInt16LE(inputs.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}
