import { it, expect, vi } from 'vitest';
import { UpdateController, type UpdateArtifact } from '../src/updateController';
function artifact(): UpdateArtifact {
  return {
    version: '1.0.2',
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}
it('keeps a verified download intact when an earlier timer checks again', async () => {
  const update = artifact(),
    check = vi.fn(async () => update),
    controller = new UpdateController(check);
  const scheduledCheck = controller.checkNow;
  await scheduledCheck(true);
  await scheduledCheck(true);
  await controller.download();
  expect(check).toHaveBeenCalledTimes(1);
  expect(update.download).toHaveBeenCalledTimes(1);
  expect(update.close).not.toHaveBeenCalled();
  expect(controller.getSnapshot().ready).toBe(true);
  await controller.install();
  expect(update.install).toHaveBeenCalledTimes(1);
});
it('does not download stale metadata after a failed recheck', async () => {
  const update = artifact();
  const check = vi.fn().mockResolvedValueOnce(update).mockRejectedValueOnce(new Error('offline'));
  const controller = new UpdateController(check);
  await controller.checkNow(false);
  await controller.checkNow(true);
  expect(update.close).toHaveBeenCalledTimes(1);
  expect(update.download).not.toHaveBeenCalled();
  expect(controller.getSnapshot()).toMatchObject({ available: false, ready: false, busy: false });
  expect(controller.getSnapshot().status).toContain('unavailable');
});
it('serializes checks and allows retry after a download failure', async () => {
  const update = artifact();
  let resolve!: (value: UpdateArtifact) => void;
  const check = vi.fn(
    () =>
      new Promise<UpdateArtifact>((r) => {
        resolve = r;
      }),
  );
  const controller = new UpdateController(check);
  const pending = controller.checkNow(false);
  await Promise.resolve();
  await controller.checkNow(false);
  resolve(update);
  await pending;
  expect(check).toHaveBeenCalledTimes(1);
  vi.mocked(update.download).mockRejectedValueOnce(new Error('connection lost'));
  await controller.download();
  expect(controller.getSnapshot()).toMatchObject({ ready: false, busy: false, available: true });
  await controller.download();
  expect(controller.getSnapshot().ready).toBe(true);
});
it('prevents duplicate installation and reports installation errors for retry', async () => {
  const update = artifact(),
    controller = new UpdateController(async () => update);
  await controller.checkNow();
  let reject!: (reason: Error) => void;
  vi.mocked(update.install).mockImplementationOnce(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  const pending = controller.install();
  const result = expect(pending).rejects.toThrow('installer busy');
  await controller.install();
  expect(update.install).toHaveBeenCalledTimes(1);
  reject(new Error('installer busy'));
  await result;
  expect(controller.getSnapshot()).toMatchObject({ ready: true, busy: false });
  expect(controller.getSnapshot().status).toContain('installation failed');
  await controller.install();
  expect(update.install).toHaveBeenCalledTimes(2);
});
