import {
  flushMetronomeForLifecycle,
  MetronomeBackgroundFailureDelivery,
} from '../src/playback/metronome-durability';

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('metronome lifecycle durability', () => {
  test('a rejection arriving after reactivation is shown on the next safe foreground tick', () => {
    const shown = jest.fn();
    const scheduled: Array<() => void> = [];
    const delivery = new MetronomeBackgroundFailureDelivery(shown, callback =>
      scheduled.push(callback),
    );

    delivery.appStateChanged('background');
    delivery.appStateChanged('active');
    delivery.report('late disk failure');

    expect(shown).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    expect(shown).toHaveBeenCalledWith('late disk failure');
  });

  test('a scheduled foreground failure never updates UI after unmount', () => {
    const shown = jest.fn();
    const scheduled: Array<() => void> = [];
    const delivery = new MetronomeBackgroundFailureDelivery(
      shown,
      callback => scheduled.push(callback),
      true,
    );

    delivery.report('late disk failure');
    delivery.unmount();
    scheduled.shift()!();

    expect(shown).not.toHaveBeenCalled();
  });

  test.each(['background', 'unmount'] as const)(
    '%s waits for a blocked durable write',
    async reason => {
      const blocked = deferred();
      const store = { flush: jest.fn(() => blocked.promise) };
      let settled = false;

      const result = flushMetronomeForLifecycle(reason, { store }).then(
        value => {
          settled = true;
          return value;
        },
      );
      await Promise.resolve();

      expect(store.flush).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      blocked.resolve();
      await expect(result).resolves.toBe(true);
    },
  );

  test('failed flush is reported to the lifecycle owner without an unhandled rejection', async () => {
    const onFailure = jest.fn();
    const store = {
      flush: jest.fn(async () => {
        throw new Error('disk unavailable');
      }),
    };

    await expect(
      flushMetronomeForLifecycle('player back', { store, onFailure }),
    ).resolves.toBe(false);
    expect(onFailure).toHaveBeenCalledWith(
      expect.stringMatching(/disk unavailable/),
    );
  });
});
