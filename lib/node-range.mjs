// Runtime check, same range as package.json engines: >=24.15.0 <25 || >=26 <27
// Node 26.11.0 renamed DatabaseSync to Database (DatabaseSync kept as an alias).
export const NODE_RANGE = '>=24.15.0 <25 || >=26 <27';
export const NODE_HINT = 'djdb uses node:sqlite. Install Node 24 (24.15 or later) or Node 26, for example with nvm install 24, and run djdb with it.';

export function nodeSupported(v = process.versions.node) {
  const [a, b] = String(v).split('.').map(Number);
  return (a === 24 && b >= 15) || a === 26;
}

export function assertNode(v = process.versions.node) {
  if (!nodeSupported(v)) {
    const err = new Error(`djdb-mcp requires Node ${NODE_RANGE} (this is ${v})`);
    err.code = 'unsupported_node';
    throw err;
  }
}
