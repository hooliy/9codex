import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

let nodePtyEntry = null;
let nodePtyUrl = null;

export function initialize({ entry }) {
  nodePtyEntry = entry;
  nodePtyUrl = pathToFileURL(entry).href;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node-pty" && nodePtyEntry) {
    return {
      url: nodePtyUrl,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === nodePtyUrl) {
    return {
      format: "commonjs",
      source: await fs.readFile(nodePtyEntry),
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
