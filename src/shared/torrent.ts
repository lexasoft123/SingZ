// Enable after the verified metadata catalog and HTTPS service are published.
export const TORRENT_FILENAME_SEARCH_ENABLED = false
/** Torrent transport contracts shared by Electron and the phone bridges. */
export type TorrentRequest =
  | {
      op: 'account' | 'connect' | 'logout' | 'status' | 'queue' | 'pause' | 'resume' | 'cancel'
    }
  | {
      op: 'search'
      query: string
      offset?: number
      mode?: 'release' | 'filename'
    }
  | { op: 'consume'; release?: string; index?: number }
  | { op: 'remove'; release: string; index: number }
  | { op: 'files'; release: string }
  | { op: 'start'; release: string; index: number }
export type TorrentResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string }
export interface TorrentRelease {
  id: string
  title: string
  size: number
  seeders: number
  matches?: TorrentFile[]
  matchCount?: number
  seedersUpdatedAt?: string
}
export interface TorrentFile {
  index: number
  name: string
  path: string
  size: number
}
export interface TorrentFiles {
  name: string
  total: number
  files: TorrentFile[]
}
export interface TorrentJob {
  release: string
  index: number
  name: string
  size: number
  done: number
  speed: number
  state: 'queued' | 'paused' | 'downloading' | 'verifying' | 'complete' | 'error'
  error?: string
}
export interface TorrentQueue {
  paused: boolean
  downloads: TorrentJob[]
}
export interface TorrentCoverage {
  indexedTorrents: number
  indexedFiles: number
  expectedTorrents: number | null
  source: string
  updatedAt: string | null
  complete: boolean
}
export interface TorrentImport {
  path: string
  name: string
  size: number
}
export interface TorrentSearch {
  coverage?: TorrentCoverage
  releases: TorrentRelease[]
  nextOffset: number
  hasMore: boolean
}
export type TorrentTransport = (request: TorrentRequest) => Promise<TorrentResult>
export const RUTRACKER_ORIGIN = 'https://rutracker.org'
/** Cookie presence restores the account UI without a network request. The
 * authenticated page remains authoritative when performing a search. */
export function hasRuTrackerSession(
  cookies: ReadonlyArray<{ name: string; value: string }>
): boolean {
  return cookies.some(
    ({ name, value }) => (name === 'bb_session' || name === 'bb_data') && value.length > 0
  )
}

export function validTorrentRequest(input: unknown): input is TorrentRequest {
  if (!input || typeof input !== 'object') return false
  const r = input as Record<string, unknown>
  if (typeof r.op !== 'string') return false
  if (
    ['account', 'connect', 'logout', 'status', 'queue', 'pause', 'resume', 'cancel'].includes(r.op)
  )
    return true
  if (r.op === 'consume' && r.release === undefined && r.index === undefined) return true
  if (r.op === 'search')
    return (
      (r.mode === undefined || r.mode === 'release' || r.mode === 'filename') &&
      typeof r.query === 'string' &&
      r.query.trim().length > 0 &&
      r.query.length <= 200 &&
      (r.offset === undefined ||
        (Number.isInteger(r.offset) && Number(r.offset) >= 0 && Number(r.offset) <= 10000))
    )
  if (r.op === 'files' || r.op === 'start' || r.op === 'remove' || r.op === 'consume')
    return (
      typeof r.release === 'string' &&
      /^[1-9][0-9]{0,11}$/.test(r.release) &&
      (r.op === 'files' ||
        (Number.isInteger(r.index) && Number(r.index) >= 0 && Number(r.index) < 25000))
    )
  return false
}
const cp1251 =
  '\u0402\u0403\u201a\u0453\u201e\u2026\u2020\u2021\u20ac\u2030\u0409\u2039\u040a\u040c\u040b\u040f\u0452\u2018\u2019\u201c\u201d\u2022\u2013\u2014\ufffd\u2122\u0459\u203a\u045a\u045c\u045b\u045f\u00a0\u040e\u045e\u0408\u00a4\u0490\u00a6\u00a7\u0401\u00a9\u0404\u00ab\u00ac\u00ad\u00ae\u0407\u00b0\u00b1\u0406\u0456\u0491\u00b5\u00b6\u00b7\u0451\u2116\u0454\u00bb\u0458\u0405\u0455\u0457\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u0419\u041a\u041b\u041c\u041d\u041e\u041f\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042a\u042b\u042c\u042d\u042e\u042f\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043a\u043b\u043c\u043d\u043e\u043f\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044a\u044b\u044c\u044d\u044e\u044f'
export function ruTrackerSearchURL(query: string, offset = 0): string {
  let encoded = ''
  for (const c of query.trim()) {
    const n = c.codePointAt(0)!
    const byte = n < 128 ? n : cp1251.indexOf(c) + 128
    if (n >= 128 && byte === 127)
      throw new Error('RuTracker supports Latin and Cyrillic text. Remove unsupported characters.')
    encoded +=
      byte < 128 && /[A-Za-z0-9._~-]/.test(c)
        ? c
        : '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return RUTRACKER_ORIGIN + '/forum/tracker.php?nm=' + encoded + '&o=10&s=2&start=' + offset
}
// Runs only inside the site browser, where HTML entities, character encoding
// and table recovery are handled by the browser's actual DOM parser.
export const RUTRACKER_ACCOUNT_SCRIPT = 'Boolean(document.querySelector("#logged-in-username"))'
export const RUTRACKER_SEARCH_SCRIPT = `(()=>{
 if(!document.querySelector('#logged-in-username'))return JSON.stringify({ok:false,error:'Your RuTracker session has expired. Sign in again.'});
 const table=document.querySelector('#tor-tbl');
 if(!table&&!/не найден|нет подходящ/i.test(document.body.textContent))return JSON.stringify({ok:false,error:'RuTracker returned an unfamiliar search page. Try again later.'});
 const seen=new Set();const releases=[];
 for(const row of document.querySelectorAll('#tor-tbl tbody tr')){
  const title=row.querySelector('a.tLink'),download=row.querySelector('a.tr-dl');
  if(!title||!download)continue;
  const id=new URL(title.getAttribute('href'),location.href).searchParams.get('t');
  if(!/^[1-9][0-9]{0,11}$/.test(id||'')||seen.has(id))continue;
  const seed=row.querySelector('td.seedmed b')||row.querySelector('td:nth-child(7) b');
  const size=row.querySelector('td.tor-size');
  const seeders=Number((seed&&seed.textContent||'0').replace(/[^0-9]/g,''))||0;
  releases.push({id,title:title.textContent.trim(),size:Number(size&&size.getAttribute('data-ts_text'))||0,seeders});
  seen.add(id);
 }
 releases.sort((a,b)=>b.seeders-a.seeders);
 const offset=Number(new URL(location.href).searchParams.get('start'))||0;
 const hasMore=Array.from(document.querySelectorAll('a[href*="start="]')).some(a=>{
  try{const url=new URL(a.getAttribute('href'),location.href);return url.pathname.endsWith('/tracker.php')&&Number(url.searchParams.get('start'))>offset}catch{return false}
 });
 return JSON.stringify({ok:true,data:{releases,nextOffset:offset+50,hasMore}});
})()`

/** Body for WKWebView.callAsyncJavaScript or an async browser function.
 * "topic" is supplied by trusted native code after release-ID validation. */
export const RUTRACKER_METADATA_BODY = `
 const response=await fetch('/forum/dl.php?t='+topic,{credentials:'same-origin'});
 if(!response.ok)throw new Error('RuTracker did not return the torrent file. Sign in again or try later.');
 if(new URL(response.url).origin!=='https://rutracker.org')throw new Error('RuTracker redirected to another site.');
 if(!response.body)throw new Error('RuTracker returned an empty torrent file.');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;
  if(size>16777216)throw new Error('RuTracker returned an unexpectedly large torrent file.');
  chunks.push(next.value);
 }}finally{reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 if(bytes[0]!==100)throw new Error('Your RuTracker session may have expired. Sign in again.');
 let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));
 return btoa(binary);
`

export interface TorrentViewState {
  view: 'account' | 'search' | 'files' | 'download'
  connected: boolean
  mode: 'release' | 'filename'
  coverage: TorrentCoverage | null
  queue: TorrentQueue
  busy: boolean
  error: string | null
  query: string
  releases: TorrentRelease[]
  release: TorrentRelease | null
  listing: TorrentFiles | null
  selected: number | null
  job: TorrentJob | null
  nextOffset: number
  hasMore: boolean
}
/** Both UIs drive one platform-neutral state machine. Every long response
 * carries a generation so a dismissed or superseded screen cannot adopt it. */
export class TorrentFlow {
  private listeners = new Set<() => void>()
  private generation = 0
  private disposed = false
  private polling = false
  private timer: ReturnType<typeof setInterval> | null = null
  state: TorrentViewState = {
    view: 'search',
    connected: false,
    mode: 'release',
    coverage: null,
    queue: { paused: false, downloads: [] },
    busy: true,
    error: null,
    query: '',
    releases: [],
    release: null,
    listing: null,
    selected: null,
    job: null,
    nextOffset: 0,
    hasMore: false
  }
  constructor(private transport: TorrentTransport) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(next: Partial<TorrentViewState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...next }
    this.listeners.forEach((f) => f())
  }
  private async call<T>(request: TorrentRequest): Promise<T> {
    const result = await this.transport(request)
    if (!result.ok) throw new Error(result.error)
    return result.data as T
  }
  async initialize(): Promise<void> {
    if (this.disposed) return
    const seq = ++this.generation
    if (!this.timer)
      this.timer = setInterval(() => {
        void this.poll()
      }, 1000)
    try {
      const job = await this.call<TorrentJob | null>({ op: 'status' })
      if (seq !== this.generation || this.disposed) return
      if (job) this.update({ job, view: 'download', busy: false })
      const queue = await this.call<TorrentQueue | null>({ op: 'queue' })
      if (seq !== this.generation || this.disposed) return
      if (queue) this.update({ queue })
      const account = await this.call<{ connected: boolean }>({
        op: 'account'
      })
      if (seq !== this.generation || this.disposed) return
      this.update({
        connected: account.connected,
        job,
        view: job ? 'download' : account.connected ? 'search' : 'account',
        busy: false
      })
      if (!this.timer)
        this.timer = setInterval(() => {
          void this.poll()
        }, 1000)
    } catch (error) {
      if (seq === this.generation) {
        this.update({
          error: String(error instanceof Error ? error.message : error),
          busy: false
        })
        if (this.state.job && !this.timer)
          this.timer = setInterval(() => {
            void this.poll()
          }, 1000)
      }
    }
  }
  private async poll(): Promise<void> {
    if (this.polling || this.disposed || this.state.busy) return
    this.polling = true
    const seq = this.generation
    try {
      const job = await this.call<TorrentJob | null>({ op: 'status' })
      const queue = await this.call<TorrentQueue | null>({ op: 'queue' })
      if (seq === this.generation) this.update({ job, ...(queue ? { queue } : {}) })
    } catch (error) {
      if (seq === this.generation)
        this.update({
          error: String(error instanceof Error ? error.message : error)
        })
    } finally {
      this.polling = false
    }
  }
  private async run(action: () => Promise<Partial<TorrentViewState>>): Promise<void> {
    if (this.state.busy || this.disposed) return
    const seq = ++this.generation
    this.update({ busy: true, error: null })
    try {
      const next = await action()
      if (seq === this.generation) this.update({ ...next, busy: false })
    } catch (error) {
      if (seq === this.generation)
        this.update({
          error: String(error instanceof Error ? error.message : error),
          busy: false
        })
    }
  }
  connect = (): Promise<void> =>
    this.run(async () => {
      const account = await this.call<{ connected: boolean }>({
        op: 'connect'
      })
      return {
        connected: account.connected,
        view: this.state.job ? 'download' : account.connected ? 'search' : 'account'
      }
    })
  logout = (): Promise<void> =>
    this.run(async () => {
      await this.call({ op: 'logout' })
      return { connected: false, view: 'account', releases: [] }
    })
  search = (query: string, more = false): Promise<void> =>
    this.run(async () => {
      const result = await this.call<TorrentSearch>({
        op: 'search',
        query,
        mode: this.state.mode,
        offset: more ? this.state.nextOffset : 0
      })
      const byId = new Map((more ? this.state.releases : []).map((r) => [r.id, r]))
      result.releases.forEach((r) => byId.set(r.id, r))
      return {
        query,
        coverage: result.coverage ?? null,
        releases: [...byId.values()].sort((a, b) => b.seeders - a.seeders),
        view: 'search',
        release: null,
        listing: null,
        selected: null,
        nextOffset: result.nextOffset,
        hasMore: result.hasMore
      }
    })
  choose = (release: TorrentRelease): Promise<void> =>
    this.run(async () => {
      const listing = await this.call<TorrentFiles>({
        op: 'files',
        release: release.id
      })
      return { release, listing, selected: null, view: 'files' }
    })
  browse = (): void => {
    if (!this.state.busy)
      this.update({
        view: this.state.connected ? 'search' : 'account',
        error: null
      })
  }
  downloads = (): void => {
    if (!this.state.busy) this.update({ view: 'download', error: null })
  }
  setMode = (mode: 'release' | 'filename'): void => {
    if (!this.state.busy && mode !== this.state.mode)
      this.update({
        mode,
        releases: [],
        query: '',
        coverage: null,
        nextOffset: 0,
        hasMore: false
      })
  }
  remove = (job: TorrentJob): Promise<void> =>
    this.run(async () => {
      const current = await this.call<TorrentJob | null>({
        op: 'remove',
        release: job.release,
        index: job.index
      })
      const queue = await this.call<TorrentQueue>({ op: 'queue' })
      return { job: current, queue }
    })
  select = (index: number): void => {
    if (this.state.listing?.files.some((f) => f.index === index)) this.update({ selected: index })
  }
  back = (): void => {
    if (!this.state.busy)
      this.update({
        view: this.state.job ? 'download' : this.state.connected ? 'search' : 'account',
        error: null
      })
  }
  account = (): void => {
    if (!this.state.busy) this.update({ view: 'account', error: null })
  }
  download = (): Promise<void> =>
    this.run(async () => {
      if (!this.state.release || this.state.selected === null) throw new Error('Select one song')
      const job = await this.call<TorrentJob>({
        op: 'start',
        release: this.state.release.id,
        index: this.state.selected
      })
      const queue = await this.call<TorrentQueue | null>({ op: 'queue' })
      return { job, view: 'download', ...(queue ? { queue } : {}) }
    })
  control = (op: 'pause' | 'resume' | 'cancel'): Promise<void> =>
    this.run(async () => {
      const job = await this.call<TorrentJob | null>({ op })
      const queue = await this.call<TorrentQueue | null>({ op: 'queue' })
      return { job, view: 'download', ...(queue ? { queue } : {}) }
    })
  async consume(job?: TorrentJob): Promise<TorrentImport | null> {
    if (this.state.busy || this.disposed) return null
    const seq = ++this.generation
    this.update({ busy: true, error: null })
    try {
      const file = await this.call<TorrentImport>({
        op: 'consume',
        ...(job ? { release: job.release, index: job.index } : {})
      })
      if (seq !== this.generation || this.disposed) return null
      this.update({ busy: false })
      return file
    } catch (error) {
      if (seq === this.generation)
        this.update({
          busy: false,
          error: String(error instanceof Error ? error.message : error)
        })
      return null
    }
  }
  dispose(): void {
    this.disposed = true
    ++this.generation
    if (this.timer) clearInterval(this.timer)
    this.listeners.clear()
  }
}
