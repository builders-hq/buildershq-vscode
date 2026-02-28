import { execFile } from 'child_process';
import * as os from 'os';

/**
 * Plays a WAV file using a platform-appropriate system command.
 * Errors are silently swallowed — audio is best-effort.
 */
export function playSound(soundFilePath: string): void {
  const platform = os.platform();
  if (platform === 'win32') {
    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(New-Object System.Media.SoundPlayer '${soundFilePath.replace(/'/g, "''")}').PlaySync()`,
    ], () => {});
  } else if (platform === 'darwin') {
    execFile('afplay', [soundFilePath], () => {});
  } else {
    // Linux: try aplay (ALSA), fall back to paplay (PulseAudio)
    execFile('aplay', [soundFilePath], (err) => {
      if (err) { execFile('paplay', [soundFilePath], () => {}); }
    });
  }
}
