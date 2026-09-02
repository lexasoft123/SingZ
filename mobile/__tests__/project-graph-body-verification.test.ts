import { NativeModules } from 'react-native';
import cases from '../../tests/shared/graph-document-cases.json';
import { md5Text, utf8TextByteLength } from '../src/md5';
import { loadProjectGraph, type ProjectEntry } from '../src/projects';
import type { ProjectDoc } from '../src/model';

describe('mobile project graph body verification', () => {
  test('rejects a graph replaced while its read is in flight', async () => {
    const expected = JSON.stringify(cases.base);
    const replacement = JSON.stringify({
      ...cases.base,
      concurrentReplacement: { validButUnbound: true },
    });
    const doc = {
      name: 'Song',
      version: 2,
      songFile: 'song.flac',
      settings: { tracks: {} },
      graphHash: {
        format: 1,
        md5: md5Text(expected),
        size: utf8TextByteLength(expected),
        mtimeMs: 1,
      },
    } as ProjectDoc;
    const entry = {
      dir: 'Song', doc, stems: {}, cached: true, bytes: 0, source: 'folder',
    } as ProjectEntry;
    let returnBody!: (value: string) => void;
    const body = new Promise<string>(resolve => { returnBody = resolve; });
    const folder = NativeModules.FolderAccess as {
      readText?: jest.Mock;
      statFile?: jest.Mock;
    };
    const previousRead = folder.readText;
    const previousStat = folder.statFile;
    folder.readText = jest.fn(() => body);
    folder.statFile = jest.fn(async () => ({
      md5: doc.graphHash!.md5,
      size: doc.graphHash!.size,
      mtimeMs: 1,
    }));
    try {
      const loading = loadProjectGraph(entry, doc);
      returnBody(replacement);
      await expect(loading).rejects.toThrow('graph.json does not match graphHash');
      // The body itself is authoritative; a preceding successful stat cannot
      // bless different bytes returned by the following read.
      expect(folder.statFile).not.toHaveBeenCalled();
      expect(folder.readText).toHaveBeenCalledTimes(1);
    } finally {
      folder.readText = previousRead;
      folder.statFile = previousStat;
    }
  });

  test('matches native/Node UTF-8 byte size for multibyte and lone surrogates', () => {
    for (const text of ['ascii', 'Звук 🎤', '\ud800x\udc00']) {
      expect(utf8TextByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
    }
  });
});
