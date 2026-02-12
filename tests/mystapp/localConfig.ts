import fs from 'node:fs';
import path from 'node:path';

export type MystappLocalConfig = {
  baseURL?: string;
  user?: string;
  password?: string;
  users?: string[];
  userPrefix?: string;
};

export function readMystappLocalConfig(): MystappLocalConfig | undefined {
  // Playwright can run worker processes with a different `cwd` than repo root.
  // Keep `.mystapp.local.json` at repo root and search upwards robustly.
  const findUp = (startDir: string, fileName: string, maxLevels = 12) => {
    let dir = startDir;
    for (let i = 0; i <= maxLevels; i++) {
      const candidate = path.join(dir, fileName);
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  };

  const filePath = findUp(process.cwd(), '.mystapp.local.json') ?? findUp(__dirname, '.mystapp.local.json');
  try {
    if (!filePath) return undefined;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as MystappLocalConfig;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
