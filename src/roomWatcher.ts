import * as os from 'os';

interface PresenceDoc {
  computerName?: string;
  presenceKey: string;
  status: string;
}

interface PresenceCurrentResponse {
  active: PresenceDoc[];
}

/**
 * Polls /api/presence/current for the current workspace and fires callbacks
 * when a new person (identified by computerName or presenceKey) appears.
 *
 * The first poll seeds the known-people set without triggering notifications —
 * only people who arrive after the extension starts will trigger the sound.
 */
export class RoomWatcher {
  private readonly knownPeople = new Set<string>();
  private initialized = false;
  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  private readonly joinCallbacks: ((displayName: string) => void)[] = [];
  private readonly ownComputerName: string;

  constructor(
    private readonly workspaceId: string,
    private readonly currentEndpointUrl: string,
    private readonly pollIntervalMs = 60_000,
  ) {
    this.ownComputerName = os.hostname();
  }

  start(): void {
    void this.poll();
    this.intervalHandle = setInterval(() => { void this.poll(); }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  dispose(): void {
    this.stop();
    this.joinCallbacks.length = 0;
  }

  onPersonJoined(cb: (displayName: string) => void): void {
    this.joinCallbacks.push(cb);
  }

  private async poll(): Promise<void> {
    try {
      const url =
        `${this.currentEndpointUrl}?workspaceId=${encodeURIComponent(this.workspaceId)}&ttlSeconds=300`;
      const res = await fetch(url);
      if (!res.ok) { return; }
      const data = await res.json() as PresenceCurrentResponse;

      for (const doc of data.active ?? []) {
        const key = doc.computerName?.trim() || doc.presenceKey;
        // Exclude self
        if (key === this.ownComputerName) { continue; }
        if (!this.knownPeople.has(key)) {
          this.knownPeople.add(key);
          if (this.initialized) {
            const displayName = doc.computerName ?? key.substring(0, 16);
            for (const cb of this.joinCallbacks) {
              cb(displayName);
            }
          }
        }
      }

      this.initialized = true;
    } catch {
      // Silently swallow — polling is best-effort
    }
  }
}
