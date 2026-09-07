import { NativeModules } from 'react-native';
import { getStoredText, setStoredText } from '../latency';
import { log } from '../log';
import {
  MET_DEFAULTS,
  sanitizeMetronome,
  type MetronomeConfig,
  type ProjectDoc,
} from '../model';
import { mutateProjectDocument } from '../project-document';

export const METRONOME_OVERRIDES_KEY = 'singz.metronome.overrides';
export const METRONOME_PHONE_JOURNAL_KEY = 'singz.metronome.phone-journal';
/** Kept for callers/tests written while this preference covered Drive only. */
export const DRIVE_METRONOME_OVERRIDES_KEY = METRONOME_OVERRIDES_KEY;
const DRIVE_ACCOUNT_EMAIL_KEY = 'singz.gdrive.email';
const FORMAT_VERSION = 1;
export const MAX_METRONOME_OVERRIDE_BYTES = 64 * 1024;
export const MAX_METRONOME_OVERRIDE_ENTRIES = 512;
const MAX_IDENTITY_BYTES = 4096;
const MAX_PERSIST_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [15, 75] as const;
let revisionNonce = 0;

export interface MetronomeProjectRef {
  readonly source: 'phone' | 'picked' | 'gdrive' | 'readonly';
  readonly dir: string;
  /** Picked root path (iOS bookmark URL) or tree URI (Android SAF). */
  readonly root?: string;
  /** Why this load path could not prove a persistence identity. */
  readonly reason?: string;
}

export interface MetronomePersistenceApi {
  readonly readProjectText: (project: string, file: string) => Promise<string>;
  readonly writeProjectText: (
    project: string,
    file: string,
    text: string,
  ) => Promise<boolean>;
  readonly getPreference: (key: string) => Promise<string | null>;
  readonly setPreference: (key: string, value: string) => Promise<void>;
  readonly delay?: (ms: number) => Promise<void>;
}

interface DriveOverrideDocument {
  readonly formatVersion: 1;
  readonly entries: Record<string, MetronomeConfig>;
}

interface PhoneJournalEntry {
  readonly revision: string;
  readonly config: MetronomeConfig;
}

interface PhoneJournalDocument {
  readonly formatVersion: 1;
  readonly entries: Record<string, PhoneJournalEntry>;
}

interface PendingWrite {
  readonly ref: MetronomeProjectRef;
  readonly config: MetronomeConfig;
  readonly attempt: number;
  readonly sequence: number;
  readonly journalRevision: string;
}

interface FolderAccessWriter {
  readText(project: string, file: string): Promise<string>;
  writeText(project: string, file: string, text: string): Promise<boolean>;
}

const Folder = NativeModules.FolderAccess as FolderAccessWriter;
const nativeApi: MetronomePersistenceApi = {
  readProjectText: (project, file) => Folder.readText(project, file),
  writeProjectText: (project, file, text) =>
    Folder.writeText(project, file, text),
  getPreference: getStoredText,
  setPreference: setStoredText,
};

/**
 * Resolves the one metronome configuration playback and the UI consume, then
 * serializes changes back to the authority available on this phone.
 *
 * Phone projects are writable: every save enters the shared project document
 * transaction and replaces only settings.metronome, so analysis, lyrics and
 * split fields survive. Picked folders and Drive are read-only from this
 * writer (Android SAF has no write contract), so both use strict format-1
 * local overrides keyed by their root/account plus project identity.
 * The strongest stable Drive identity currently exposed to JS is the signed-
 * in account email plus the project directory name. Drive folder ids are not
 * retained in ProjectEntry/the offline catalog. Consequently a folder rename
 * intentionally starts with the project value again. Picked roots similarly
 * expose only the resolved bookmark path/tree URI, not a cross-rename folder
 * id. Exposing those ids later would permit a format-2 migration without
 * guessing across accounts or storage providers.
 */
export class MobileMetronomePersistence {
  private readonly desired = new Map<string, PendingWrite>();
  private readonly latest = new Map<string, PendingWrite>();
  private readonly processing = new Set<string>();
  private readonly failures = new Map<string, Error>();
  private acceptance: Promise<void> = Promise.resolve();
  private journalTail: Promise<void> = Promise.resolve();
  private pump: Promise<void> | null = null;
  private sequence = 0;

  constructor(private readonly api: MetronomePersistenceApi = nativeApi) {}

  /** Resolve a sanitized config into a fresh doc before eligibility/playback. */
  async resolve(
    ref: MetronomeProjectRef,
    fallback: ProjectDoc,
  ): Promise<ProjectDoc> {
    const key = pendingKey(ref);
    const pending = this.latest.get(key);
    if (ref.source === 'readonly')
      return withMetronome(
        fallback,
        pending?.config ?? fallback.settings?.metronome,
      );
    if (ref.source === 'phone') {
      let current = fallback;
      try {
        current = parseProject(
          await this.api.readProjectText(ref.dir, 'project.json'),
        );
      } catch {
        // A moved, temporarily unavailable, or malformed file must not make
        // the player unusable. The catalog copy is the best available truth.
      }
      let journaled: PhoneJournalEntry | null = null;
      try {
        journaled = await this.readPhoneJournal(ref.dir);
      } catch {
        // A malformed/future journal never makes a project unplayable. It is
        // ignored for playback but preserved; edits reject rather than erase
        // unknown entries that may still be valid to a newer app.
      }
      const newest = this.latest.get(key);
      if (journaled) this.reconcilePhoneJournal(ref, journaled);
      return withMetronome(
        current,
        newest?.config ?? journaled?.config ?? current.settings?.metronome,
      );
    }

    if (pending) return withMetronome(fallback, pending.config);
    try {
      const identity = await this.overrideIdentity(ref);
      const overrides = await this.loadOverrides();
      return withMetronome(
        fallback,
        overrides?.entries[identity] ?? fallback.settings?.metronome,
      );
    } catch {
      return withMetronome(fallback, fallback.settings?.metronome);
    }
  }

  /**
   * Accept one complete config only after its durable native preference write.
   * Phone projects journal first, then coalesce their slower project.json
   * merge. Picked/Drive overrides are themselves the durable preference.
   */
  save(ref: MetronomeProjectRef, raw: unknown): Promise<void> {
    const config = sanitizeMetronome(raw);
    const key = pendingKey(ref);
    const sequence = ++this.sequence;
    const accepted = this.acceptance.then(async () => {
      this.failures.delete(key);
      this.failures.delete('pump');
      if (ref.source === 'readonly') {
        const failure = new Error(
          `Metronome preference is read-only: ${
            ref.reason ?? 'project source identity is unavailable'
          }`,
        );
        this.failures.set(key, failure);
        log('metronome', failure.message, 'error');
        throw failure;
      }
      if (ref.source !== 'phone') {
        await this.retryAcceptedWrite(ref, () =>
          this.persistOverride(ref, config),
        );
        this.failures.delete(key);
        return;
      }

      const write: PendingWrite = {
        ref: { ...ref },
        config,
        attempt: 0,
        sequence,
        journalRevision: revision(sequence),
      };
      await this.retryAcceptedWrite(ref, () =>
        this.putPhoneJournal(ref.dir, write.journalRevision, config),
      );
      this.latest.set(key, write);
      this.desired.set(key, write);
      this.failures.delete(key);
      this.ensurePump();
    });
    this.acceptance = accepted.catch(() => undefined);
    return accepted;
  }

  /** Wait for durable success. Exhausted retries reject instead of reporting
   * a false clean flush while the value exists only in memory. */
  async flush(): Promise<void> {
    while (true) {
      const accepting = this.acceptance;
      await accepting;
      if (this.pump) await this.pump;
      if (accepting === this.acceptance && this.pump === null) break;
    }
    if (this.failures.size > 0)
      throw new Error(
        [...this.failures.values()].map(failure => failure.message).join(' | '),
      );
  }

  private ensurePump(): void {
    if (this.pump) return;
    const run = Promise.resolve()
      .then(() => this.awaitAcceptedWrites())
      .then(() => this.persist())
      .catch(error => {
        const failure = new Error(
          `Metronome persistence pump failed: ${message(error)}`,
        );
        this.failures.set('pump', failure);
        log('metronome', failure.message, 'error');
      });
    this.pump = run;
    run.finally(() => {
      if (this.pump !== run) return;
      this.pump = null;
      if (this.desired.size > 0) this.ensurePump();
    });
  }

  private async awaitAcceptedWrites(): Promise<void> {
    while (true) {
      const accepting = this.acceptance;
      await accepting;
      if (accepting === this.acceptance) return;
    }
  }

  private async persist(): Promise<void> {
    while (this.desired.size > 0) {
      const pending = [...this.desired.values()];
      this.desired.clear();
      for (let index = 0; index < pending.length; index++) {
        const write = pending[index];
        const key = pendingKey(write.ref);
        this.processing.add(key);
        try {
          await this.persistPhone(write.ref.dir, write.config);
          await this.clearPhoneJournal(write.ref.dir, write.journalRevision);
          if (this.latest.get(key)?.sequence === write.sequence)
            this.latest.delete(key);
          this.failures.delete(key);
        } catch (error) {
          // A newer tap can still be landing in the native journal while the
          // older project merge fails. Let accepted writes publish `desired`
          // before deciding whether retrying this obsolete snapshot is useful.
          await this.awaitAcceptedWrites();
          const newer = this.desired.has(key);
          const detail = message(error);
          if (newer) {
            log(
              'metronome',
              `save attempt superseded after failure · ${write.ref.source}:${write.ref.dir} · ${detail}`,
              'warn',
            );
            continue;
          }
          if (write.attempt + 1 < MAX_PERSIST_ATTEMPTS) {
            const retry = { ...write, attempt: write.attempt + 1 };
            this.desired.set(key, retry);
            for (const waiting of pending.slice(index + 1)) {
              const waitingKey = pendingKey(waiting.ref);
              if (!this.desired.has(waitingKey))
                this.desired.set(waitingKey, waiting);
            }
            const delayMs =
              RETRY_DELAYS_MS[write.attempt] ?? RETRY_DELAYS_MS.at(-1)!;
            log(
              'metronome',
              `save failed · retry ${
                retry.attempt + 1
              }/${MAX_PERSIST_ATTEMPTS} in ${delayMs} ms · ` +
                `${write.ref.source}:${write.ref.dir} · ${detail}`,
              'warn',
            );
            await (this.api.delay ?? delay)(delayMs);
            break;
          }
          const failure = new Error(
            `Metronome preference was not saved after ${MAX_PERSIST_ATTEMPTS} attempts: ${detail}`,
          );
          this.failures.set(key, failure);
          log('metronome', failure.message, 'error');
          for (const waiting of pending.slice(index + 1)) {
            const waitingKey = pendingKey(waiting.ref);
            if (!this.desired.has(waitingKey))
              this.desired.set(waitingKey, waiting);
          }
          break;
        } finally {
          this.processing.delete(key);
        }
      }
    }
  }

  private async persistPhone(
    dir: string,
    config: MetronomeConfig,
  ): Promise<void> {
    await mutateProjectDocument(
      dir,
      current => withMetronome(current, config),
      {
        readText: this.api.readProjectText,
        writeText: this.api.writeProjectText,
      },
    );
  }

  private reconcilePhoneJournal(
    ref: MetronomeProjectRef,
    journaled: PhoneJournalEntry,
  ): void {
    const key = pendingKey(ref);
    const latest = this.latest.get(key);
    if (latest) {
      if (!this.desired.has(key) && !this.processing.has(key)) {
        this.desired.set(key, { ...latest, attempt: 0 });
        this.failures.delete(key);
        this.ensurePump();
      }
      return;
    }
    const write: PendingWrite = {
      ref: { ...ref },
      config: journaled.config,
      attempt: 0,
      sequence: ++this.sequence,
      journalRevision: journaled.revision,
    };
    this.latest.set(key, write);
    this.desired.set(key, write);
    this.failures.delete(key);
    this.ensurePump();
  }

  private async retryAcceptedWrite(
    ref: MetronomeProjectRef,
    write: () => Promise<void>,
  ): Promise<void> {
    const key = pendingKey(ref);
    let detail = 'unknown persistence failure';
    for (let attempt = 0; attempt < MAX_PERSIST_ATTEMPTS; attempt++) {
      try {
        await write();
        return;
      } catch (error) {
        detail = message(error);
        if (attempt + 1 >= MAX_PERSIST_ATTEMPTS) break;
        const delayMs = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1)!;
        log(
          'metronome',
          `durable save failed · retry ${
            attempt + 2
          }/${MAX_PERSIST_ATTEMPTS} ` +
            `in ${delayMs} ms · ${ref.source}:${ref.dir} · ${detail}`,
          'warn',
        );
        await (this.api.delay ?? delay)(delayMs);
      }
    }
    const failure = new Error(
      `Metronome preference was not saved after ${MAX_PERSIST_ATTEMPTS} attempts: ${detail}`,
    );
    this.failures.set(key, failure);
    log('metronome', failure.message, 'error');
    throw failure;
  }

  private readPhoneJournal(dir: string): Promise<PhoneJournalEntry | null> {
    return this.withJournal(async () => {
      const journal = await this.loadPhoneJournal();
      return journal?.entries[phoneJournalIdentity(dir)] ?? null;
    });
  }

  private putPhoneJournal(
    dir: string,
    journalRevision: string,
    config: MetronomeConfig,
  ): Promise<void> {
    return this.withJournal(async () => {
      const current = await this.loadPhoneJournal();
      const next = boundedJournal(current, phoneJournalIdentity(dir), {
        revision: journalRevision,
        config,
      });
      await this.api.setPreference(
        METRONOME_PHONE_JOURNAL_KEY,
        JSON.stringify(next),
      );
    });
  }

  private clearPhoneJournal(
    dir: string,
    journalRevision: string,
  ): Promise<void> {
    return this.withJournal(async () => {
      const current = await this.loadPhoneJournal();
      const identity = phoneJournalIdentity(dir);
      if (current.entries[identity]?.revision !== journalRevision) return;
      const entries = { ...current.entries };
      delete entries[identity];
      await this.api.setPreference(
        METRONOME_PHONE_JOURNAL_KEY,
        JSON.stringify({ formatVersion: FORMAT_VERSION, entries }),
      );
    });
  }

  private withJournal<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.journalTail.then(operation);
    this.journalTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadPhoneJournal(): Promise<PhoneJournalDocument> {
    const raw = await this.api.getPreference(METRONOME_PHONE_JOURNAL_KEY);
    // `== null`, not `=== null`: an absent key reaches JS as `undefined` on
    // iOS (see `storedText` in ../latency). The boundary normalizes it now,
    // but the parsers below index the value directly, so a second reader of
    // this store must never be able to reintroduce the crash.
    return raw == null || raw === '' ? journalDefaults() : restoreJournal(raw);
  }

  private async persistOverride(
    ref: MetronomeProjectRef,
    config: MetronomeConfig,
  ): Promise<void> {
    const identity = await this.overrideIdentity(ref);
    const current = await this.loadOverrides();
    const next = boundedOverrides(current, identity, config);
    await this.api.setPreference(METRONOME_OVERRIDES_KEY, JSON.stringify(next));
  }

  private async overrideIdentity(ref: MetronomeProjectRef): Promise<string> {
    if (ref.source === 'picked') {
      const root = ref.root?.trim() ?? '';
      if (!root)
        throw new RangeError('Picked-folder metronome identity has no root.');
      return checkedIdentity(JSON.stringify(['picked', root, ref.dir]));
    }
    if (ref.source !== 'gdrive')
      throw new RangeError('Phone projects do not use metronome overrides.');
    const email =
      (await this.api.getPreference(DRIVE_ACCOUNT_EMAIL_KEY))
        ?.trim()
        .toLowerCase() ?? '';
    return checkedIdentity(
      JSON.stringify(['gdrive', email || 'unknown-account', ref.dir]),
    );
  }

  private async loadOverrides(): Promise<DriveOverrideDocument> {
    const raw = await this.api.getPreference(METRONOME_OVERRIDES_KEY);
    // See loadPhoneJournal: `== null` covers the absent-key `undefined`.
    return raw == null || raw === '' ? defaults() : restoreOverrides(raw);
  }
}

function pendingKey(ref: MetronomeProjectRef): string {
  return JSON.stringify([ref.source, ref.root ?? '', ref.dir]);
}

function withMetronome(doc: ProjectDoc, raw: unknown): ProjectDoc {
  return {
    ...doc,
    settings: {
      ...(doc.settings ?? { transpose: 0, tracks: {} }),
      metronome: sanitizeMetronome(raw ?? MET_DEFAULTS),
    },
  };
}

function parseProject(text: string): ProjectDoc {
  const raw = JSON.parse(text) as unknown;
  if (!plainObject(raw)) throw new RangeError('Project document is invalid.');
  const doc = raw as unknown as ProjectDoc;
  if (!plainObject(doc.settings))
    throw new RangeError('Project settings are invalid.');
  return doc;
}

function defaults(): DriveOverrideDocument {
  return { formatVersion: FORMAT_VERSION, entries: {} };
}

function journalDefaults(): PhoneJournalDocument {
  return { formatVersion: FORMAT_VERSION, entries: {} };
}

function phoneJournalIdentity(dir: string): string {
  return checkedIdentity(JSON.stringify(['phone', dir]));
}

function revision(sequence: number): string {
  revisionNonce++;
  return `${Date.now().toString(36)}-${sequence.toString(
    36,
  )}-${revisionNonce.toString(36)}`;
}

function restoreOverrides(text: string): DriveOverrideDocument {
  if (utf8Bytes(text) > MAX_METRONOME_OVERRIDE_BYTES)
    throw new RangeError('Metronome overrides are too large.');
  const raw = JSON.parse(text) as unknown;
  if (!plainObject(raw))
    throw new RangeError('Metronome overrides are invalid.');
  const root = raw as Record<string, unknown>;
  if (
    !exactKeys(root, ['entries', 'formatVersion']) ||
    root.formatVersion !== FORMAT_VERSION
  )
    throw new RangeError('Unsupported metronome override document.');
  if (!plainObject(root.entries))
    throw new RangeError('Metronome override entries are invalid.');
  const pairs = Object.entries(root.entries);
  if (pairs.length > MAX_METRONOME_OVERRIDE_ENTRIES)
    throw new RangeError('Metronome override entries are too large.');
  const entries: Record<string, MetronomeConfig> = {};
  for (const [identity, value] of pairs) {
    if (
      utf8Bytes(identity) === 0 ||
      utf8Bytes(identity) > MAX_IDENTITY_BYTES ||
      !strictConfig(value)
    )
      throw new RangeError('Metronome override entry is invalid.');
    entries[identity] = value;
  }
  return { formatVersion: FORMAT_VERSION, entries };
}

function restoreJournal(text: string): PhoneJournalDocument {
  if (utf8Bytes(text) > MAX_METRONOME_OVERRIDE_BYTES)
    throw new RangeError('Metronome journal is too large.');
  const raw = JSON.parse(text) as unknown;
  if (!plainObject(raw)) throw new RangeError('Metronome journal is invalid.');
  const root = raw as Record<string, unknown>;
  if (
    !exactKeys(root, ['entries', 'formatVersion']) ||
    root.formatVersion !== FORMAT_VERSION ||
    !plainObject(root.entries)
  )
    throw new RangeError('Unsupported metronome journal document.');
  const pairs = Object.entries(root.entries);
  if (pairs.length > MAX_METRONOME_OVERRIDE_ENTRIES)
    throw new RangeError('Metronome journal entries are too large.');
  const entries: Record<string, PhoneJournalEntry> = {};
  for (const [identity, value] of pairs) {
    if (
      utf8Bytes(identity) === 0 ||
      utf8Bytes(identity) > MAX_IDENTITY_BYTES ||
      !plainObject(value) ||
      !exactKeys(value, ['config', 'revision']) ||
      typeof value.revision !== 'string' ||
      !/^[a-z0-9-]{1,64}$/.test(value.revision) ||
      !strictConfig(value.config)
    )
      throw new RangeError('Metronome journal entry is invalid.');
    entries[identity] = {
      revision: value.revision,
      config: value.config,
    };
  }
  return { formatVersion: FORMAT_VERSION, entries };
}

/** Add/update one entry and deterministically evict lexically earliest peers until
 * the exact strict reader bounds are satisfied. The value being written is
 * always retained; all peers are considered cache-like local overrides. */
function boundedOverrides(
  current: DriveOverrideDocument,
  identity: string,
  config: MetronomeConfig,
): DriveOverrideDocument {
  const entries = { ...current.entries, [identity]: sanitizeMetronome(config) };
  const evict = Object.keys(entries)
    .filter(key => key !== identity)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const make = (): DriveOverrideDocument => ({
    formatVersion: FORMAT_VERSION,
    entries,
  });
  while (
    Object.keys(entries).length > MAX_METRONOME_OVERRIDE_ENTRIES ||
    utf8Bytes(JSON.stringify(make())) > MAX_METRONOME_OVERRIDE_BYTES
  ) {
    const victim = evict.shift();
    if (victim === undefined)
      throw new RangeError(
        'This metronome override cannot fit in the preference document.',
      );
    delete entries[victim];
  }
  return make();
}

function boundedJournal(
  current: PhoneJournalDocument,
  identity: string,
  entry: PhoneJournalEntry,
): PhoneJournalDocument {
  const entries = { ...current.entries, [identity]: entry };
  const next: PhoneJournalDocument = {
    formatVersion: FORMAT_VERSION,
    entries,
  };
  if (
    Object.keys(entries).length > MAX_METRONOME_OVERRIDE_ENTRIES ||
    utf8Bytes(JSON.stringify(next)) > MAX_METRONOME_OVERRIDE_BYTES
  )
    // Journal entries represent UI-accepted values that project.json has not
    // proved yet. Evicting one would turn a successful tap into silent loss;
    // reject the new acceptance instead and let reconciliation make room.
    throw new RangeError('The metronome journal is full. Try again shortly.');
  return next;
}

function checkedIdentity(identity: string): string {
  if (utf8Bytes(identity) === 0 || utf8Bytes(identity) > MAX_IDENTITY_BYTES)
    throw new RangeError('Metronome override identity is too large.');
  return identity;
}

function strictConfig(raw: unknown): raw is MetronomeConfig {
  if (!plainObject(raw)) return false;
  if (!exactKeys(raw, ['accent', 'click', 'countInBars', 'volume']))
    return false;
  return (
    typeof raw.click === 'boolean' &&
    Number.isInteger(raw.countInBars) &&
    (raw.countInBars as number) >= 0 &&
    (raw.countInBars as number) <= 2 &&
    typeof raw.volume === 'number' &&
    Number.isFinite(raw.volume) &&
    raw.volume >= 0 &&
    raw.volume <= 1 &&
    typeof raw.accent === 'boolean'
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const mobileMetronomePersistence = new MobileMetronomePersistence();
