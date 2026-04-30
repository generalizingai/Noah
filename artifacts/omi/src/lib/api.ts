import { Plugin } from '@/types/plugin';

const API_BASE = '/api/omi';

let cachedPlugins: Plugin[] | null = null;

async function normalizePlugins(raw: (Omit<Plugin, 'capabilities'> & { capabilities: string[] | null })[]): Promise<Plugin[]> {
  return raw.map(p => ({
    ...p,
    capabilities: new Set(p.capabilities || []),
  }));
}

export async function getApprovedApps(): Promise<Plugin[]> {
  if (cachedPlugins) return cachedPlugins;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${API_BASE}/apps`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to fetch apps: ${response.statusText}`);
    }

    const raw = await response.json();
    const plugins = await normalizePlugins(raw);
    cachedPlugins = plugins;
    return plugins;
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    const err = error as Error;
    if (err.name === 'AbortError') {
      return cachedPlugins ?? [];
    }
    return cachedPlugins ?? [];
  }
}

export async function getAppById(id: string): Promise<Plugin | undefined> {
  const plugins = await getApprovedApps();
  return plugins.find((p) => p.id === id);
}

export async function getAppsByCategory(category: string): Promise<Plugin[]> {
  const plugins = await getApprovedApps();
  return category === 'integration'
    ? plugins.filter((plugin) => plugin.capabilities.has('external_integration'))
    : plugins.filter((plugin) => plugin.category === category);
}
