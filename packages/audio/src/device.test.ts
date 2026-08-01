/**
 * `DeviceRegistry`, which exists mostly to turn browser exceptions into faults the chip can show.
 *
 * The contract's sharpest line: "Rejects with an `AudioFault`, never with a bare `Error` — the
 * chip needs the kind." A `DOMException` reaching the interaction machine is an Error state with
 * no message worth showing and no way to tell "you said no" from "there is no microphone".
 */

import { describe, expect, it, vi } from 'vitest';
import { createDeviceRegistry, DEFAULT_CAPTURE_REQUEST, type MediaDevicesLike } from './device.js';
import type { AudioDeviceInfo } from './device.js';
import type { AudioFault, DeviceId, MicStream } from './types.js';

const INPUT: AudioDeviceInfo = {
  id: 'in-1' as DeviceId,
  label: 'MacBook Pro Microphone',
  kind: 'input',
  isDefault: true,
};
const OUTPUT: AudioDeviceInfo = {
  id: 'out-1' as DeviceId,
  label: 'MacBook Pro Speakers',
  kind: 'output',
  isDefault: true,
};

function media(over: Partial<MediaDevicesLike> = {}) {
  let onChange: (() => void) | null = null;
  let devices: readonly AudioDeviceInfo[] = [INPUT, OUTPUT];

  const base: MediaDevicesLike = {
    enumerate: () => Promise.resolve(devices),
    getUserMedia: () => Promise.resolve({ id: 'stream-1' } as MicStream),
    stop: vi.fn(),
    onDeviceChange: (listener) => {
      onChange = listener;
      return () => {
        onChange = null;
      };
    },
    permission: () => Promise.resolve('granted'),
    ...over,
  };

  return {
    media: base,
    setDevices: (next: readonly AudioDeviceInfo[]): void => {
      devices = next;
    },
    fireChange: () => onChange?.(),
  };
}

describe('opening the device', () => {
  it('asks for echo cancellation, which is not optional', async () => {
    // Without AEC the model hears itself and self-interrupts in a loop (realtime §11.5) — the
    // failure ADR-0001 chose Electron over Tauri to avoid.
    expect(DEFAULT_CAPTURE_REQUEST.echoCancellation).toBe(true);

    const getUserMedia = vi.fn(() => Promise.resolve({ id: 's' } as MicStream));
    const { media: devices } = media({ getUserMedia });
    await createDeviceRegistry(devices).open(DEFAULT_CAPTURE_REQUEST);

    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ echoCancellation: true }) as unknown,
    );
  });

  it('rejects with mic-denied when the user said no', async () => {
    const { media: devices } = media({
      getUserMedia: () =>
        Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })),
    });

    const fault = (await createDeviceRegistry(devices)
      .open(DEFAULT_CAPTURE_REQUEST)
      .catch((error: unknown) => error)) as AudioFault;

    expect(fault.kind).toBe('mic-denied');
    expect(fault.persistent).toBe(true);
    // ui-design §8 keeps permission faults up until resolved, so the message has to tell the
    // player what to actually do about it.
    expect(fault.message).toMatch(/System Settings/);
  });

  it('rejects with no-input-device for anything else', async () => {
    const { media: devices } = media({
      getUserMedia: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotFoundError' })),
    });
    await expect(createDeviceRegistry(devices).open(DEFAULT_CAPTURE_REQUEST)).rejects.toMatchObject(
      { kind: 'no-input-device', persistent: true },
    );
  });

  it('never rejects with a bare Error', async () => {
    const { media: devices } = media({ getUserMedia: () => Promise.reject(new Error('raw')) });
    const rejected = await createDeviceRegistry(devices)
      .open(DEFAULT_CAPTURE_REQUEST)
      .catch((error: unknown) => error);
    expect(rejected).toHaveProperty('kind');
    expect(rejected).toHaveProperty('persistent');
  });

  it('notifies fault subscribers as well as rejecting', async () => {
    const { media: devices } = media({
      getUserMedia: () =>
        Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })),
    });
    const registry = createDeviceRegistry(devices);
    const faults: AudioFault[] = [];
    registry.onFault((fault) => faults.push(fault));

    await registry.open(DEFAULT_CAPTURE_REQUEST).catch(() => undefined);
    expect(faults.map((fault) => fault.kind)).toEqual(['mic-denied']);
  });
});

describe('device change — §3.5', () => {
  it('a change that leaves an input is a swap, not a fault', async () => {
    const { media: devices, setDevices, fireChange } = media();
    const registry = createDeviceRegistry(devices);
    const faults: AudioFault[] = [];
    const changes = vi.fn();
    registry.onFault((fault) => faults.push(fault));
    registry.onChange(changes);

    setDevices([{ ...INPUT, id: 'in-2' as DeviceId, label: 'Headset' }, OUTPUT]);
    fireChange();
    await vi.waitFor(() => {
      expect(changes).toHaveBeenCalled();
    });

    expect(faults).toEqual([]);
  });

  it('losing the last input is a persistent fault', async () => {
    // "a voice coach with no microphone should not quietly look idle."
    const { media: devices, setDevices, fireChange } = media();
    const registry = createDeviceRegistry(devices);
    const faults: AudioFault[] = [];
    registry.onFault((fault) => faults.push(fault));
    registry.onChange(() => undefined);

    setDevices([OUTPUT]);
    fireChange();

    await vi.waitFor(() => {
      expect(faults).toHaveLength(1);
    });
    expect(faults[0]).toMatchObject({ kind: 'no-input-device', persistent: true });
  });

  it('does not raise a device fault when enumeration itself fails', async () => {
    const { media: devices, fireChange } = media({
      enumerate: () => Promise.reject(new Error('enumeration blew up')),
    });
    const registry = createDeviceRegistry(devices);
    const faults: AudioFault[] = [];
    registry.onFault((fault) => faults.push(fault));
    registry.onChange(() => undefined);

    fireChange();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(faults).toEqual([]);
  });
});

describe('enumeration and permission pass through', () => {
  it('lists devices', async () => {
    const { media: devices } = media();
    expect(await createDeviceRegistry(devices).list()).toEqual([INPUT, OUTPUT]);
  });

  it('reports permission without opening anything', async () => {
    const getUserMedia = vi.fn();
    const { media: devices } = media({ permission: () => Promise.resolve('prompt'), getUserMedia });
    expect(await createDeviceRegistry(devices).permission()).toBe('prompt');
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
