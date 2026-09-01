import { SceneGraph } from "@open-pencil/core";
import { exportFigFile } from "@open-pencil/core/io/formats/fig";

export async function syntheticRenderableFig(): Promise<Uint8Array> {
  const graph = new SceneGraph();
  const page = graph.getPages()[0];
  if (!page) throw new Error("Synthetic SceneGraph did not create a page");
  graph.updateNode(page.id, { name: "Synthetic render page" });
  graph.createNode("RECTANGLE", page.id, {
    name: "Safe card",
    x: 10,
    y: 20,
    width: 120,
    height: 80,
    layoutGrids: [
      {
        pattern: "GRID",
        sectionSize: 10,
        color: { r: 1, g: 0, b: 0, a: 1 },
        visible: true,
      },
    ],
    fills: [
      {
        type: "SOLID",
        color: { r: 0.2, g: 0.4, b: 0.8, a: 1 },
        opacity: 1,
        visible: true,
      },
    ],
  });

  return exportFigFile(graph);
}
