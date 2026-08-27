function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeMcpServerName(value) {
  const name = normalizeText(value);
  if (!name) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`invalid Codex MCP server name: ${value}`);
  }
  return name;
}

export function normalizeDisabledMcpServers(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeMcpServerName).filter(Boolean);
  }
  const text = normalizeText(value);
  if (!text || text.toLowerCase() === 'none') return [];
  return text.split(',').map(normalizeMcpServerName).filter(Boolean);
}

export function buildCodexAppServerArgs({
  enabledFeatures = [],
  disabledMcpServers = [],
  modelCatalogJson = null,
} = {}) {
  const args = ['app-server', '--listen', 'stdio://'];
  if (modelCatalogJson) args.push('-c', `model_catalog_json=${JSON.stringify(String(modelCatalogJson))}`);
  for (const serverName of normalizeDisabledMcpServers(disabledMcpServers)) {
    args.push('-c', `mcp_servers.${serverName}.enabled=false`);
  }
  for (const feature of enabledFeatures) {
    const name = normalizeText(feature);
    if (!name) continue;
    args.push('--enable', name);
  }
  return args;
}
