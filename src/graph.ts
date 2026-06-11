/**
 * Relationship graph: link artifacts that share session UUIDs.
 *
 * Session UUIDs appear in file paths throughout the `.claude` tree
 * (e.g. `projects/<enc>/<uuid>.jsonl`, `cot/transcript/<uuid>.*`,
 * `shell-snapshots`, todos, tasks). This module extracts those UUIDs from
 * file paths/names, builds a bipartite graph of uuid-nodes ↔ file-nodes,
 * and trims it to a renderable size.
 */

/** UUID v4 pattern — matches standard hyphenated hex UUIDs case-insensitively. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** A node in the relationship graph. */
export interface GraphNode {
  /** Stable unique id used for edge references. */
  id: string;
  /** Either a UUID or a file/directory path. */
  type: "uuid" | "file";
  /** Display label (UUID or the basename/short path). */
  label: string;
  /** Root-relative path — present for file nodes only. */
  path?: string;
  /** Number of edges connected to this node. */
  degree: number;
}

/** A directed edge (source ↔ target are interchangeable; the graph is undirected). */
export interface GraphEdge {
  source: string;
  target: string;
}

/** Output of {@link buildGraph}. */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Statistics returned alongside the graph data by the endpoint. */
export interface GraphStats {
  /** Total file paths scanned. */
  files: number;
  /** Total unique UUIDs found. */
  uuids: number;
  /** True when the returned nodes/edges were capped (graph was larger). */
  truncated: boolean;
}

/**
 * Extract all unique UUIDs from a string (lowercased for canonical form).
 *
 * @param str  Any string — typically a file path or file name.
 * @returns    Array of lower-cased UUID strings (de-duped within this string).
 */
export function extractUuids(str: string): string[] {
  const matches = str.toLowerCase().match(UUID_RE);
  if (!matches) return [];
  // De-dup within a single string (a UUID could appear more than once).
  return [...new Set(matches)];
}

/**
 * Build a bipartite relationship graph from a flat list of root-relative file
 * paths.
 *
 * Each file whose path/name contains at least one UUID gets a file-node. Each
 * distinct UUID gets a uuid-node. An edge connects every uuid-node to every
 * file-node whose path contains that UUID.
 *
 * @param filePaths  Root-relative forward-slash file paths to index.
 * @returns          Nodes and edges (degrees filled in, unsorted).
 */
export function buildGraph(filePaths: string[]): GraphData {
  // uuid → Set<filePath>
  const uuidToFiles = new Map<string, Set<string>>();
  // filePath → Set<uuid>
  const fileToUuids = new Map<string, Set<string>>();

  for (const p of filePaths) {
    const uuids = extractUuids(p);
    if (uuids.length === 0) continue;
    for (const uuid of uuids) {
      if (!uuidToFiles.has(uuid)) uuidToFiles.set(uuid, new Set());
      uuidToFiles.get(uuid)!.add(p);
    }
    if (!fileToUuids.has(p)) fileToUuids.set(p, new Set());
    for (const uuid of uuids) fileToUuids.get(p)!.add(uuid);
  }

  // Build nodes — degree is incremented below as edges are created.
  const nodes = new Map<string, GraphNode>();

  const getOrCreateUuidNode = (uuid: string): GraphNode => {
    if (!nodes.has(uuid)) {
      nodes.set(uuid, {
        id: uuid,
        type: "uuid",
        label: uuid,
        degree: 0,
      });
    }
    return nodes.get(uuid)!;
  };

  const getOrCreateFileNode = (filePath: string): GraphNode => {
    if (!nodes.has(filePath)) {
      // Use the basename as the label; it's still unambiguous in the tooltip.
      const label = filePath.split("/").pop() ?? filePath;
      nodes.set(filePath, {
        id: filePath,
        type: "file",
        label,
        path: filePath,
        degree: 0,
      });
    }
    return nodes.get(filePath)!;
  };

  const edges: GraphEdge[] = [];

  for (const [uuid, files] of uuidToFiles) {
    const uuidNode = getOrCreateUuidNode(uuid);
    for (const filePath of files) {
      const fileNode = getOrCreateFileNode(filePath);
      edges.push({ source: uuid, target: filePath });
      uuidNode.degree++;
      fileNode.degree++;
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/**
 * Maximum number of nodes retained after degree-based trimming.
 * Nodes with the highest degree are kept; the rest are pruned along with
 * their edges so the renderer stays performant.
 */
export const GRAPH_NODE_CAP = 300;

/**
 * Trim a {@link GraphData} to at most {@link GRAPH_NODE_CAP} nodes by
 * removing the lowest-degree nodes (and the edges that touch only them).
 *
 * @param data  Full graph from {@link buildGraph}.
 * @returns     Possibly-smaller graph; `truncated` is true when pruning occurred.
 */
export function trimGraph(data: GraphData): GraphData & { truncated: boolean } {
  if (data.nodes.length <= GRAPH_NODE_CAP) {
    return { ...data, truncated: false };
  }

  // Sort descending by degree; keep the top GRAPH_NODE_CAP.
  const sorted = [...data.nodes].sort((a, b) => b.degree - a.degree);
  const kept = new Set(sorted.slice(0, GRAPH_NODE_CAP).map((n) => n.id));

  // Keep only edges where both endpoints survive.
  const edges = data.edges.filter((e) => kept.has(e.source) && kept.has(e.target));
  const nodes = sorted.slice(0, GRAPH_NODE_CAP);

  return { nodes, edges, truncated: true };
}
