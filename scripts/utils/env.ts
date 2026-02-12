import { existsSync } from 'fs';

export async function readEnvFile(path = '.env'): Promise<Record<string, string>> {
  if (!existsSync(path)) return {};
  const text = await Bun.file(path).text();
  const lines = text.split(/\r?\n/);
  const out: Record<string, string> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

export function getEnvValue(env: Record<string, string>, key: string, fallback = ''): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

export async function mergeEnvFile(
  path: string,
  updates: Record<string, string>,
  options?: { headerComment?: string[] }
): Promise<void> {
  const hasFile = existsSync(path);
  const existingText = hasFile ? await Bun.file(path).text() : '';
  const lines = hasFile ? existingText.split(/\r?\n/) : [];

  const seen = new Set<string>();
  const out: string[] = [];
  const keyRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

  for (const line of lines) {
    const match = line.match(keyRegex);
    if (!match) {
      out.push(line);
      continue;
    }

    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      out.push(`${key}=${updates[key] ?? ''}`);
      seen.add(key);
    } else {
      out.push(line);
    }
  }

  const missing = Object.keys(updates).filter((key) => !seen.has(key));

  if (!hasFile && options?.headerComment?.length) {
    out.push(...options.headerComment);
    if (missing.length > 0) out.push('');
  }

  if (missing.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    for (const key of missing) {
      out.push(`${key}=${updates[key] ?? ''}`);
    }
  }

  if (out.length > 0 && out[out.length - 1] !== '') out.push('');
  await Bun.write(path, out.join('\n'));
}
