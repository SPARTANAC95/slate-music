export interface UpdateArtifact {
  version: string;
  download(): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}
export class UpdateController {
  private artifact: UpdateArtifact | null = null;
  private listeners = new Set<() => void>();
  private state = {
    status: 'Updates are checked automatically.',
    ready: false,
    available: false,
    busy: false,
  };
  constructor(private check: () => Promise<UpdateArtifact | null>) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private change(patch: Partial<typeof this.state>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  checkNow = async (autoDownload = true) => {
    if (this.state.busy || this.state.ready) return;
    this.change({ busy: true, available: false, status: 'Checking for updates…' });
    const previous = this.artifact;
    this.artifact = null;
    try {
      await previous?.close().catch(() => {});
      this.artifact = await this.check();
      this.change({
        available: !!this.artifact,
        status: this.artifact
          ? `Version ${this.artifact.version} is available.`
          : 'You have the latest version.',
      });
    } catch {
      this.change({
        status: 'Update service is unavailable. Check your connection or try again later.',
      });
    } finally {
      this.change({ busy: false });
    }
    if (this.artifact && autoDownload) await this.download();
  };
  download = async () => {
    if (!this.artifact || this.state.busy || this.state.ready) return;
    this.change({ busy: true, status: 'Downloading update…' });
    try {
      await this.artifact.download();
      this.change({
        ready: true,
        status: `Version ${this.artifact.version} is verified and ready to install.`,
      });
    } catch (error) {
      this.change({ status: `Update download failed: ${String(error)}` });
    } finally {
      this.change({ busy: false });
    }
  };
  install = async () => {
    if (!this.state.ready || !this.artifact || this.state.busy) return;
    this.change({ busy: true, status: 'Installing update…' });
    try {
      await this.artifact.install();
    } catch (error) {
      this.change({ status: `Update installation failed: ${String(error)}. You can try again.` });
      throw error;
    } finally {
      this.change({ busy: false });
    }
  };
}
