import os from 'node:os';
import path from 'node:path';

export function defaultVellumStateDirectory(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return path.join(process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'Vellum');
  }
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Vellum');
  return path.join(process.env['XDG_STATE_HOME'] ?? path.join(os.homedir(), '.local', 'state'), 'vellum');
}

export function defaultVellumConfigurationDirectory(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return path.join(process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Vellum');
  }
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Vellum');
  return path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'), 'vellum');
}
