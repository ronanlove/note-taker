import { defaultTools, type InkTools } from './ink';
import type { Kind } from './notes';

export interface Settings {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  /** Type of note the app opens to. */
  capture: Kind;
}

const KEY = 'jot.settings';

const defaults = (): Settings => ({
  owner: '',
  repo: '',
  branch: 'main',
  token: '',
  capture: matchMedia('(pointer: coarse)').matches ? 'ink' : 'text',
});

export function loadSettings(): Settings {
  try {
    return { ...defaults(), ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return defaults();
  }
}

export function saveSettings(settings: Settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

const TOOLS_KEY = 'jot.tools';

export function loadTools(): InkTools {
  const d = defaultTools();
  try {
    const saved = JSON.parse(localStorage.getItem(TOOLS_KEY) ?? '{}');
    return { ...d, ...saved, pens: { ...d.pens, ...saved.pens }, markers: { ...d.markers, ...saved.markers } };
  } catch {
    return d;
  }
}

export function saveTools(tools: InkTools) {
  localStorage.setItem(TOOLS_KEY, JSON.stringify(tools));
}

export const isConfigured = (s: Settings) => Boolean(s.owner && s.repo && s.token);

/** Accepts "owner/repo" or a github.com URL. */
export function parseRepo(input: string): { owner: string; repo: string } | null {
  const m = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/(\.git)?\/*$/, '')
    .match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}
