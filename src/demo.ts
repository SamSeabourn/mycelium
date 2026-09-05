import { withinHops } from "./subgraph";

export const twoHops = (g: Record<string, string[]>, seeds: string[]) => withinHops(g, seeds, 2);
