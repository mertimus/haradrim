import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";

interface ForceNode extends SimulationNodeDatum {
  id: string;
  isCenter: boolean;
  importance: number;
  nodeSize: number;
  hubX?: number;
  hubY?: number;
  fx?: number | null;
  fy?: number | null;
}

interface ForceLink extends SimulationLinkDatum<ForceNode> {
  source: string;
  target: string;
  distance: number;
}

interface WorkerInput {
  nodes: ForceNode[];
  links: ForceLink[];
  ticks?: number;
}

interface WorkerOutput {
  positions: Record<string, { x: number; y: number }>;
}

self.onmessage = (e: MessageEvent<WorkerInput>) => {
  const { nodes, links, ticks = 400 } = e.data;

  const sim = forceSimulation<ForceNode>(nodes)
    .force(
      "link",
      forceLink<ForceNode, ForceLink>(links)
        .id((d) => d.id)
        .distance((d) => d.distance)
        .strength(1.2),
    )
    .force("charge", forceManyBody<ForceNode>().strength(-180))
    .force("center", forceCenter(0, 0).strength(0.1))
    .force(
      "collide",
      forceCollide<ForceNode>().radius((d) => d.nodeSize * 0.55 + 15).strength(0.8),
    )
    .force(
      "hubX",
      forceX<ForceNode>((d) => d.hubX ?? 0).strength((d) => (d.isCenter ? 0 : 0.4)),
    )
    .force(
      "hubY",
      forceY<ForceNode>((d) => d.hubY ?? 0).strength((d) => (d.isCenter ? 0 : 0.4)),
    )
    .stop();

  for (let i = 0; i < ticks; i++) sim.tick();

  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    positions[node.id] = { x: node.x ?? 0, y: node.y ?? 0 };
  }

  const output: WorkerOutput = { positions };
  self.postMessage(output);
};
