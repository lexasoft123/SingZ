//! Production DropScreen composition over an isolated, read-only sample collection.
use crate::i18n::{t,tv,tn};
use crate::a11y::ButtonSurface;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::*;
use singz_uikit::tokens::{DIM, FAINT, TEXT};
use singz_uikit::{catalog_project_card, catalog_project_delete, catalog_search, ghost_pill, production_scrollbar, text_link};
use std::{
    sync::{Arc, OnceLock},
    time::Instant,
};

actions!(singz_library_drive, [NextCatalogFocus, PreviousCatalogFocus]);

/// Source-browser rounded bars plus their shadows, before the CSS scaleY.
/// Kept separately so animation transforms the complete primitive, including
/// vertical corner curvature and shadow blur, rather than resizing its box.
fn equalizer_primitives() -> &'static [Arc<RenderImage>] {
    static IMAGES: OnceLock<Vec<Arc<RenderImage>>> = OnceLock::new();
    IMAGES.get_or_init(|| {
        let atlas = image::load_from_memory(include_bytes!("../assets/equalizer-primitives.png"))
            .expect("compiled equalizer primitive atlas")
            .to_rgba8();
        (0..56)
            .map(|index| {
                let mut bar =
                    image::imageops::crop_imm(&atlas, (index % 8) * 88, (index / 8) * 268, 88, 268)
                        .to_image();
                // GPUI RenderImage expects BGRA bytes.
                for pixel in bar.pixels_mut() {
                    pixel.0.swap(0, 2);
                }
                Arc::new(RenderImage::new(vec![image::Frame::new(bar)]))
            })
            .collect()
    })
}

#[derive(Clone)]
pub enum LibraryEvent {
    OpenSong {
        title: SharedString,
        artist: SharedString,
    },
    OpenProject(std::path::PathBuf),
    Browse,
    ManageStorage,
    Drive(crate::drive_state::Action),
    DriveBrowse,
    DeleteSong {
        title: SharedString,
    },
    DeleteProject(std::path::PathBuf),
}

struct DemoSong {
    title: &'static str,
    artist: &'static str,
    saved: &'static str,
    lyrics: bool,
}

// Original, fictional song names; never project paths or live service records.
const SONGS: [DemoSong; 12] = [
    DemoSong {
        title: "Room to breathe",
        artist: "SingZ studio",
        saved: "Nov 6",
        lyrics: true,
    },
    DemoSong {
        title: "Paper lanterns",
        artist: "Mira Vale",
        saved: "Nov 5",
        lyrics: true,
    },
    DemoSong {
        title: "A little closer",
        artist: "The morning room",
        saved: "Nov 5",
        lyrics: true,
    },
    DemoSong {
        title: "After the rain",
        artist: "June Harbour",
        saved: "Nov 4",
        lyrics: false,
    },
    DemoSong {
        title: "Golden hour",
        artist: "Mira Vale",
        saved: "Nov 3",
        lyrics: true,
    },
    DemoSong {
        title: "Slow river",
        artist: "Ellis North",
        saved: "Nov 2",
        lyrics: false,
    },
    DemoSong {
        title: "Under the same sky",
        artist: "June Harbour",
        saved: "Nov 1",
        lyrics: true,
    },
    DemoSong {
        title: "Stay for the sunrise",
        artist: "The morning room",
        saved: "Oct 30",
        lyrics: true,
    },
    DemoSong {
        title: "Quiet streets",
        artist: "Ellis North",
        saved: "Oct 28",
        lyrics: false,
    },
    DemoSong {
        title: "Find your way home",
        artist: "SingZ studio",
        saved: "Oct 26",
        lyrics: true,
    },
    DemoSong {
        title: "Small beginnings",
        artist: "Mira Vale",
        saved: "Oct 24",
        lyrics: true,
    },
    DemoSong {
        title: "Light in the window",
        artist: "June Harbour",
        saved: "Oct 20",
        lyrics: true,
    },
];

#[derive(Clone, PartialEq, Eq)]
struct CatalogSong {
    title: String,
    /// Lowercase title, built once when the catalog arrives: a search keystroke
    /// then filters without allocating a lowercase copy of every title.
    lower: String,
    saved: String,
    lyrics: bool,
    project_dir: Option<std::path::PathBuf>,
    stems: usize,
}
impl CatalogSong {
    fn new(title: String, saved: String, lyrics: bool, project_dir: Option<std::path::PathBuf>, stems: usize) -> Self {
        Self { lower: title.to_lowercase(), title, saved, lyrics, project_dir, stems }
    }
}

pub struct LibraryScreen {
    backdrop_revision: u64,
    pub guides: singz_uikit::GuideAnchors,
    page_scroll: ScrollHandle,
    songs: Vec<CatalogSong>,
    native_root: String,
    delete_error: Option<String>,
    drive: crate::drive_state::Snapshot,
    #[cfg(feature = "ui-tests")]
    guide_native_fixture: bool,
    drive_focus: std::cell::RefCell<std::collections::HashMap<String, FocusHandle>>,
    drive_bounds: std::rc::Rc<std::cell::RefCell<std::collections::HashMap<String, Bounds<Pixels>>>>,
    revealed_drive_focus: Option<String>,
    card_focus: std::cell::RefCell<std::collections::HashMap<(std::path::PathBuf,bool),FocusHandle>>,
    search: Entity<InputState>,
    query: String,
    open_song: Option<SharedString>,
    animation_epoch: Instant,
    animation_time: Option<f32>,
    scroll: ScrollHandle,
    suspended_at: Option<Instant>,
    _search_subscription: Subscription,
    #[cfg(feature = "ui-tests")]
    delete_bounds: std::rc::Rc<
        std::cell::RefCell<std::collections::HashMap<std::path::PathBuf, Bounds<Pixels>>>,
    >,
    #[cfg(feature = "ui-tests")]
    project_bounds: std::rc::Rc<std::cell::RefCell<std::collections::HashMap<std::path::PathBuf, Bounds<Pixels>>>>,
}

fn catalog_date(date: &str) -> String {
    let fields = date
        .get(..10)
        .unwrap_or(date)
        .split('-')
        .collect::<Vec<_>>();
    if fields.len() == 3 {
        if let (Ok(month), Ok(day)) = (fields[1].parse::<usize>(), fields[2].parse::<u32>()) {
            if (1..=12).contains(&month) && (1..=31).contains(&day) {
                return format!(
                    "{} {}",
                    [
                        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
                        "Nov", "Dec"
                    ][month - 1],
                    day
                );
            }
        }
    }
    date.into()
}

impl EventEmitter<LibraryEvent> for LibraryScreen {}

impl LibraryScreen {
    pub fn backdrop_revision(&self) -> u64 { self.backdrop_revision }
    pub fn refresh_locale(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search.update(cx, |input, cx| input.set_placeholder(crate::i18n::t("library.dropScreen.searchPlaceholder"), window, cx));
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn review_snapshot(&self) -> serde_json::Value {
        let query = self.query.trim().to_lowercase();
        let bounds = self.scroll.bounds();
        let row = self.scroll.bounds_for_item(0);
        serde_json::json!({
            "query": self.query,
            "matches": SONGS.iter().filter(|song| query.is_empty() || song.title.to_lowercase().contains(&query)).map(|song|song.title).collect::<Vec<_>>(),
            "fixture": SONGS.iter().map(|song|serde_json::json!({"title":song.title,"artist":song.artist,"saved":song.saved,"lyrics":song.lyrics})).collect::<Vec<_>>(),
            "grid": {"x":f32::from(bounds.left()),"y":f32::from(bounds.top()),"width":f32::from(bounds.size.width),"height":f32::from(bounds.size.height),"scrollTop":-f32::from(self.scroll.offset().y),"maxScroll":f32::from(self.scroll.max_offset().y)},
            "firstRow": row.map(|r|serde_json::json!({"x":f32::from(r.left()),"y":f32::from(r.top()),"width":f32::from(r.size.width),"height":f32::from(r.size.height)}))
        })
    }

    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.bind_keys([
            KeyBinding::new("tab", NextCatalogFocus, Some("SingZLibrary")),
            KeyBinding::new("shift-tab", PreviousCatalogFocus, Some("SingZLibrary")),
        ]);
        let search = cx.new(|cx| InputState::new(window, cx).placeholder(t("library.dropScreen.searchPlaceholder")));
        let subscription = cx.subscribe_in(&search, window, |this, state, event, _, cx| {
            if matches!(event, InputEvent::Change) {
                let query = state.read(cx).value().to_string();
                if this.query != query {
                    this.query = query;
                    this.backdrop_revision = this.backdrop_revision.wrapping_add(1);
                }
                cx.notify();
            }
        });
        Self {
            backdrop_revision: 0,
            native_root: String::new(),
            delete_error: None,
            drive: Default::default(),
            #[cfg(feature = "ui-tests")]
            guide_native_fixture: false,
            drive_focus: Default::default(),
            drive_bounds: Default::default(),
            revealed_drive_focus: None,
            card_focus: Default::default(),
            guides: Default::default(),
            page_scroll: ScrollHandle::new(),
            songs: if crate::integration::fixture_mode() {
                SONGS
                    .iter()
                    .map(|s| CatalogSong::new(s.title.into(), s.saved.into(), s.lyrics, None, 6))
                    .collect()
            } else {
                vec![]
            },
            search,
            query: String::new(),
            open_song: None,
            animation_epoch: Instant::now(),
            animation_time: None,
            scroll: ScrollHandle::new(),
            suspended_at: None,
            _search_subscription: subscription,
            #[cfg(feature = "ui-tests")]
            delete_bounds: Default::default(),
            #[cfg(feature = "ui-tests")]
            project_bounds: Default::default(),
        }
    }

    pub fn set_root(&mut self, root: String, cx: &mut Context<Self>) {
        if self.native_root != root {
            self.native_root = root;
            self.backdrop_revision = self.backdrop_revision.wrapping_add(1);
            cx.notify();
        }
    }
    pub fn set_drive(&mut self, drive: crate::drive_state::Snapshot, cx: &mut Context<Self>) {
        if !crate::integration::fixture_mode() && self.drive != drive {
            let (was_signed_in, was_syncing) = (self.drive.signed_in, self.drive_syncing());
            self.drive = drive;
            // D-06 rule 7: Drive sign-in and sync state changes are announced, politely.
            if was_signed_in != self.drive.signed_in {
                crate::a11y::announce(t(if self.drive.signed_in { "a11y.announce.driveSignedIn" } else { "a11y.announce.driveSignedOut" }));
            } else if was_syncing && !self.drive_syncing() {
                crate::a11y::announce(t(if self.drive.error.is_some() { "a11y.announce.driveSyncFailed" } else { "a11y.announce.driveSyncDone" }));
            }
            self.backdrop_revision = self.backdrop_revision.wrapping_add(1);
            cx.notify();
        }
    }
    fn native_catalog(&self) -> bool {
        #[cfg(feature = "ui-tests")]
        if self.guide_native_fixture { return true; }
        !crate::integration::fixture_mode()
    }
    /// Guide anchors retain historical bounds. Admit this conditional step from
    /// the currently mounted row, never from a preceding frame's cached anchor.
    pub fn sync_guide_available(&self) -> bool {
        self.native_catalog() && self.drive.configured
    }
    #[cfg(feature = "ui-tests")]
    pub fn review_guide_drive(&mut self, native: bool, configured: bool, cx: &mut Context<Self>) {
        // Exercise the real native catalog composition without starting account,
        // network or audio workers in the isolated demo-mode guide observer.
        self.guide_native_fixture = native;
        let root = crate::integration::library_root();
        self.native_root = root.display().to_string();
        // Use the real native card composition with enough fictional projects
        // for a valid scroll-to-bottom state at either desktop viewport. Demo
        // reset restores its ordinary twelve-song collection, not an empty grid.
        self.songs = (0..if native { 48 } else { SONGS.len() }).map(|index| {
            let song = &SONGS[index % SONGS.len()];
            CatalogSong::new(
                if native {format!("{} · {}",song.title,index / SONGS.len() + 1)} else {song.title.into()},
                song.saved.into(),
                song.lyrics,
                native.then(||root.join(format!("guide-project-{index:02}"))),
                6,
            )
        }).collect();
        self.prune_card_focus();
        self.drive = crate::drive_state::Snapshot { configured, ..Default::default() };
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn review_guide_page(&self) -> serde_json::Value {
        let b = self.page_scroll.bounds();
        serde_json::json!({"nativeCatalog":self.native_catalog(),"configured":self.drive.configured,
            "syncAvailable":self.sync_guide_available(),"offsetY":f32::from(self.page_scroll.offset().y),
            "maxOffsetY":f32::from(self.page_scroll.max_offset().y),
            "projectCount":self.songs.len(),"projects":self.songs.iter().map(|song|serde_json::json!({"title":song.title,"saved":song.saved,"lyrics":song.lyrics,"dir":song.project_dir,"stems":song.stems})).collect::<Vec<_>>(),
            "viewport":{"left":f32::from(b.left()),"top":f32::from(b.top()),"right":f32::from(b.right()),"bottom":f32::from(b.bottom())}})
    }
    #[cfg(feature = "ui-tests")]
    pub fn review_guide_page_top(&self) {
        self.page_scroll.set_offset(point(px(0.), px(0.)));
    }
    #[cfg(feature = "ui-tests")]
    pub fn review_guide_page_bottom(&self) {
        self.page_scroll.set_offset(point(px(0.), -self.page_scroll.max_offset().y));
    }
    pub fn drive_bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.drive_bounds.borrow().get(id).copied()
    }
    pub fn drive_state(&self, w: &Window) -> serde_json::Value {
        let enabled=self.enabled_drive_controls();
        let handles=self.drive_focus.borrow();
        let focused=enabled.iter().find(|id|handles.get(**id).is_some_and(|focus|focus.is_focused(w))).copied();
        let owns_focus=handles.values().any(|focus|focus.is_focused(w));
        serde_json::json!({"drive": self.drive,"upToDate":self.drive.is_up_to_date(),
            "focusedControl":focused,"enabledControls":enabled,"driveOwnsFocus":owns_focus,"validFocus":!owns_focus||focused.is_some()})
    }
    fn drive_syncing(&self)->bool {
        self.drive.busy || self.drive.scheduler.phase==crate::sync_scheduler::Phase::Syncing
    }
    /// Current mounted/enabled actions, independent of the preceding frame's
    /// bounds. The Drive row only exists for configured native integration.
    fn drive_control_enabled(&self,id:&str)->bool {
        if !self.sync_guide_available() {return false;}
        match id {
            "library-drive-browse"|"library-drive-log"=>self.drive.signed_in,
            "library-drive-cancel"=>self.drive_syncing(),
            "library-drive-sync"=>self.drive.signed_in&&!self.drive_syncing()&&!self.drive.signing_in,
            "library-drive-connect"=>!self.drive.signed_in&&!self.drive_syncing()&&!self.drive.signing_in,
            _=>false,
        }
    }
    fn enabled_drive_controls(&self)->Vec<&'static str> {
        ["library-drive-browse","library-drive-log","library-drive-cancel","library-drive-sync","library-drive-connect"]
            .into_iter().filter(|id|self.drive_control_enabled(id)).collect()
    }
    fn drive_handle(&self,id:&str,cx:&mut Context<Self>)->FocusHandle {
        let previous_primary=match id {
            "library-drive-connect"=>self.drive_focus.borrow().get("library-drive-sync").cloned(),
            "library-drive-sync"=>self.drive_focus.borrow().get("library-drive-connect").cloned(),
            _=>None,
        };
        self.drive_focus.borrow_mut().entry(id.into())
            .or_insert_with(||previous_primary.unwrap_or_else(||cx.focus_handle().tab_stop(true))).clone()
    }
    fn recover_drive_focus(&self,window:&mut Window,cx:&mut Context<Self>) {
        // An account/busy transition may remove the exact focused action.
        // Resolve current primary aliases before deciding it vanished: a
        // Connect handle shared by an enabled Sync control remains valid.
        if !self.drive_focus.borrow().values().any(|focus|focus.is_focused(window)) {return;}
        let enabled=self.enabled_drive_controls();
        if enabled.iter().any(|id|self.drive_handle(id,cx).is_focused(window)) {return;}
        let target=if self.drive.signed_in {
            ["library-drive-cancel","library-drive-sync","library-drive-browse"].into_iter().find(|id|self.drive_control_enabled(id))
        } else if self.drive_control_enabled("library-drive-connect") {Some("library-drive-connect")} else {None};
        if let Some(id)=target {self.drive_handle(id,cx).focus(window,cx);}
        else {self.focus_search(window,cx);}
    }
    fn drive_action(
        &self, id: &str, label: &str, action: crate::drive_state::Action,
        enabled: bool, w: &Window, cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let focus=self.drive_handle(id,cx);
        let bounds=self.drive_bounds.clone(); let probe_id=id.to_owned();
        let weak=cx.entity().downgrade();let current_id=id.to_owned();
        singz_uikit::settings_control_with_focus(singz_uikit::drive_library_action(id.to_owned(),label.to_owned(),enabled,w),focus,enabled,move|_,cx| {
            let _=weak.update(cx,|s,cx|if s.drive_control_enabled(&current_id){cx.emit(LibraryEvent::Drive(action));});
        })
            .relative().child(canvas(move |b,_,_| {bounds.borrow_mut().insert(probe_id.clone(),b);b},|_,_,_,_|{}).absolute().inset_0())
    }
    pub fn focus_drive_browse(&mut self, window:&mut Window, cx:&mut Context<Self>)->bool {
        if self.drive.signed_in && self.drive_bounds.borrow().contains_key("library-drive-browse") {
            let focus=self.drive_focus.borrow().get("library-drive-browse").cloned();
            if let Some(focus)=focus {
                focus.focus(window,cx);
                if let Some(bounds)=self.drive_bounds("library-drive-browse") {
                    self.reveal_guide(bounds);
                    self.revealed_drive_focus=Some("library-drive-browse".into());
                }
                return true;
            }
        }
        false
    }
    fn drive_browse(&self, window:&Window, cx:&mut Context<Self>)->Stateful<Div> {
        let id="library-drive-browse";
        let focus=self.drive_handle(id,cx);
        let weak=cx.entity().downgrade();
        let bounds=self.drive_bounds.clone();
        singz_uikit::settings_control_with_focus(singz_uikit::drive_library_action(id,t("library.drive.title"),true,window),focus,true,move|_,cx| {
            let _=weak.update(cx,|s,cx|if s.drive_control_enabled(id) {cx.emit(LibraryEvent::DriveBrowse);});
        }).relative().child(canvas(move|b,_,_|{bounds.borrow_mut().insert(id.into(),b);b},|_,_,_,_|{}).absolute().inset_0())
    }
    fn drive_row(&self, w: &Window, cx: &mut Context<Self>) -> Div {
        use crate::{drive_state::Action, sync_scheduler::Phase};
        let drive=&self.drive;
        let syncing=self.drive_syncing();
        let status=if drive.signing_in {
            singz_uikit::drive_status_line(t("library.common.finishGoogleSignIn"),true,true,false,true,w)
        } else if let Some(error)=&drive.error {
            singz_uikit::drive_status_line(error.clone(),true,true,false,true,w)
        } else if syncing {
            singz_uikit::drive_status_line(tv("library.dropScreen.syncProgress", &[("msg",drive.progress.clone())]),true,false,false,true,w)
        } else if drive_keeps_progress(drive) {
            // Source driveMsg survives the completed operation. It takes
            // precedence over the generic signed-in/waiting status, without
            // turning a pending or warning-bearing run into an up-to-date claim.
            singz_uikit::drive_status_line(drive.progress.clone(),true,true,false,true,w)
        } else if let Some(error)=&drive.scheduler.last_error {
            let text=if drive.scheduler.phase==Phase::Retrying {tv("library.dropScreen.retryScheduled", &[("error",error.clone())])}else{error.clone()};
            singz_uikit::drive_status_line(text,false,true,false,true,w)
        } else if drive.signed_in && drive.scheduler.phase==Phase::Pending && drive.progress_kind==crate::drive_state::ProgressKind::Finishing {
            singz_uikit::drive_status_line(drive.progress.clone(),true,false,false,true,w)
        } else if drive.is_up_to_date() {
            let label=drive.scheduler.last_sync.and_then(|time| {
                let now=chrono::Utc::now().timestamp_millis().max(0) as u64;
                let minutes=((now.saturating_sub(time)) as f64/60_000.).round() as u64;
                Some(if minutes<1 {t("library.dropScreen.justNow")}else if minutes<60 {tv("library.dropScreen.minAgo", &[("mins",minutes.to_string())])}
                    else { let hours=(minutes as f64/60.).round() as u64;
                        if hours<24 {tv("library.dropScreen.hAgo", &[("h",hours.to_string())])}else{
                            chrono::DateTime::from_timestamp_millis(time as i64)?.with_timezone(&chrono::Local).format("%b %-d").to_string()
                        }
                    })
            });
            singz_uikit::drive_synced_status_labels(t("library.dropScreen.driveCopyLives"),label.map(|value|format!("{} · {value}",t("library.dropScreen.upToDate"))).unwrap_or_else(||t("library.dropScreen.upToDate")),w)
        } else if drive.signed_in {
            // A signed-in account alone is not evidence of a durable Drive copy.
            singz_uikit::drive_status_line(t("library.dropScreen.waitingTitle"),true,false,false,false,w)
        } else {
            singz_uikit::drive_status_line(t("library.dropScreen.keepCopyHint"),true,false,true,false,w)
        };
        let mut row=singz_uikit::drive_storage_subrow().child(singz_uikit::drive_status_body().child(status));
        if drive.signed_in { row=row.child(self.drive_browse(w,cx)); }
        if drive.signed_in { row=row.child(self.drive_action("library-drive-log",&t("library.dropScreen.syncLog"),Action::ShowLog,true,w,cx)); }
        if syncing { row=row.child(self.drive_action("library-drive-cancel",&t("library.dropScreen.cancelSync"),Action::Cancel,true,w,cx)); }
        let (id,label,action)=if drive.signed_in {("library-drive-sync",t("library.dropScreen.syncNow"),Action::SyncNow)}
            else {("library-drive-connect",t("library.dropScreen.connect"),Action::SignIn)};
        row.child(self.drive_action(id,&label,action,self.drive_control_enabled(id),w,cx))
    }
    pub fn set_delete_error(&mut self, error: Option<String>, cx: &mut Context<Self>) {
        if self.delete_error != error {
            self.delete_error = error;
            self.backdrop_revision = self.backdrop_revision.wrapping_add(1);
            cx.notify();
        }
    }
    #[cfg(feature = "ui-tests")]
    pub fn delete_error(&self) -> Option<&str> {
        self.delete_error.as_deref()
    }
    pub fn set_projects(
        &mut self,
        projects: Vec<crate::integration::Project>,
        cx: &mut Context<Self>,
    ) {
        let songs = projects
            .into_iter()
            .map(|p| CatalogSong::new(p.name, catalog_date(&p.saved), p.has_lyrics, Some(p.dir), p.lanes.len()))
            .collect::<Vec<_>>();
        #[cfg(feature = "ui-tests")]
        CATALOG_DELIVERIES.fetch_add(1, std::sync::atomic::Ordering::Release);
        if self.songs != songs {
            self.songs = songs;
            self.prune_card_focus();
            self.backdrop_revision = self.backdrop_revision.wrapping_add(1);
            cx.notify();
        }
    }
    #[cfg(feature = "ui-tests")]
    pub fn project_delete_bounds(&self, dir: &std::path::Path) -> Option<Bounds<Pixels>> {
        self.delete_bounds.borrow().get(dir).copied()
    }
    #[cfg(feature = "ui-tests")]
    pub fn project_open_bounds(&self, dir: &std::path::Path) -> Option<Bounds<Pixels>> {
        self.project_bounds.borrow().get(dir).copied()
    }
    /// Catalog size, filter result and grid scroll for the large-library driver (Q-14).
    #[cfg(feature = "ui-tests")]
    pub fn long_state(&self) -> serde_json::Value {
        let grid = self.scroll.bounds();
        let filtered = self.filtered_indices();
        serde_json::json!({
            "projects": self.songs.len(), "matches": filtered.len(), "query": self.query,
            "firstMatch": filtered.first().map(|i| self.songs[*i].title.clone()),
            "firstMatchDir": filtered.first().and_then(|i| self.songs[*i].project_dir.clone()),
            "grid": {"x":f32::from(grid.left()),"y":f32::from(grid.top()),"width":f32::from(grid.size.width),"height":f32::from(grid.size.height),
                "scrollTop":-f32::from(self.scroll.offset().y),"maxScroll":f32::from(self.scroll.max_offset().y)},
            "page": {"height":f32::from(self.page_scroll.bounds().size.height),"scrollTop":-f32::from(self.page_scroll.offset().y),
                "maxScroll":f32::from(self.page_scroll.max_offset().y)},
        })
    }
    #[cfg(feature = "ui-tests")]
    pub fn project_snapshot(&self) -> serde_json::Value {
        serde_json::json!(self.songs.iter().map(|s|serde_json::json!({"dir":s.project_dir,"name":s.title,"stemCount":s.stems,"hasLyrics":s.lyrics})).collect::<Vec<_>>())
    }
    pub fn reveal_guide(&self, bounds: Bounds<Pixels>) {
        let viewport = self.page_scroll.bounds();
        let mut offset = self.page_scroll.offset();
        if bounds.top() < viewport.top() + px(8.) {
            offset.y += viewport.top() + px(8.) - bounds.top();
        } else if bounds.bottom() > viewport.bottom() - px(8.) {
            offset.y -= bounds.bottom() - viewport.bottom() + px(8.);
        }
        self.page_scroll.set_offset(offset);
    }
    pub fn focus_search(&self, window: &mut Window, cx: &mut Context<Self>) {
        let focus = self.search.read(cx).focus_handle(cx);
        focus.focus(window, cx);
    }
    fn song_key(&self, index:usize)->std::path::PathBuf {
        self.songs[index].project_dir.clone().unwrap_or_else(||format!("demo-{index}").into())
    }
    fn filtered_indices(&self)->Vec<usize> {
        let query=self.query.trim().to_lowercase();
        self.songs.iter().enumerate().filter(|(_,song)|query.is_empty()||song.lower.contains(&query)).map(|(i,_)|i).collect()
    }
    /// Forget focus handles of projects that left the catalog. Done when the catalog
    /// changes, not on every frame: rebuilding a path set of every project per frame
    /// was a cost that grew with the library.
    fn prune_card_focus(&mut self) {
        let existing=(0..self.songs.len()).map(|index|self.song_key(index)).collect::<std::collections::HashSet<_>>();
        self.card_focus.borrow_mut().retain(|(key,_),_|existing.contains(key));
    }
    fn card_focus_handle(&self,key:std::path::PathBuf,delete:bool,cx:&mut Context<Self>)->FocusHandle {
        self.card_focus.borrow_mut().entry((key,delete)).or_insert_with(||cx.focus_handle().tab_stop(true)).clone()
    }
    fn catalog_tab(&mut self,backwards:bool,window:&mut Window,cx:&mut Context<Self>)->bool {
        let indices=self.filtered_indices();
        let order=indices.iter().flat_map(|index|[(self.song_key(*index),false),(self.song_key(*index),true)]).collect::<Vec<_>>();
        let current=self.card_focus.borrow().iter().find(|(_,f)|f.is_focused(window)).map(|(key,_)|key.clone());
        let search=self.search.read(cx).focus_handle(cx).is_focused(window);
        let target=if search && !backwards {order.first().cloned()}
            else if let Some(current)=current {
                let Some(index)=order.iter().position(|key|key==&current) else{return false;};
                if backwards {
                    if index==0 {self.focus_search(window,cx);cx.notify();return true;}
                    order.get(index-1).cloned()
                }else{order.get(index+1).cloned()}
            }else{None};
        let Some((key,delete))=target else{return false;};
        let index=indices.iter().position(|i|self.song_key(*i)==key).unwrap();
        let width=(f32::from(window.viewport_size().width)-80.).min(880.).max(240.);
        let columns=((width-14.+12.)/252.).floor().max(1.) as usize;
        self.scroll.scroll_to_item(index/columns);
        self.reveal_guide(self.scroll.bounds());
        self.card_focus_handle(key,delete,cx).focus(window,cx);
        cx.notify();true
    }
    #[cfg(feature="ui-tests")]
    pub fn focused_project(&self,window:&Window)->Option<(std::path::PathBuf,bool)> {
        self.card_focus.borrow().iter().find(|(_,f)|f.is_focused(window)).map(|(key,_)|key.clone())
    }
    #[cfg(feature = "ui-tests")]
    pub fn search_focused(&self, window: &Window, cx: &App) -> bool {
        self.search.read(cx).focus_handle(cx).is_focused(window)
    }
    pub fn set_open_song(&mut self, title: Option<SharedString>, cx: &mut Context<Self>) {
        if self.open_song != title {
            self.open_song = title;
            self.backdrop_revision = self.backdrop_revision.wrapping_add(1);
            cx.notify();
        }
    }

    /// Match the reference's paused CSS animation clock in hidden captures.
    pub fn set_animation_time(&mut self, seconds: f32, cx: &mut Context<Self>) {
        self.animation_time = Some(seconds.max(0.));
        cx.notify();
    }

    pub fn set_suspended(&mut self, suspended: bool, cx: &mut Context<Self>) {
        if self.suspended_at.is_some() != suspended {
            if suspended {
                self.suspended_at = Some(Instant::now());
            } else if let Some(paused) = self.suspended_at.take() {
                self.animation_epoch += paused.elapsed();
            }
            cx.notify();
        }
    }

    fn song_card(&self, index: usize, palette: usize, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let song = &self.songs[index];
        let hues = [
            [0xf66d5c, 0xf2a83d, 0x58d68a],
            [0x5ba8f5, 0xf2a83d, 0xb58cf2],
            [0x58d68a, 0xffd97a, 0xf66d5c],
        ];
        // Native Project.dir is authoritative even when its playable audio is
        // outside the project or the project contains only stems.
        let key=self.song_key(index);
        let open_focus=self.card_focus_handle(key.clone(),false,cx);
        let delete_focus=self.card_focus_handle(key.clone(),true,cx);
        let mouse_open=open_focus.clone();let mouse_delete=delete_focus.clone();
        let open_event=if let Some(path)=&song.project_dir {LibraryEvent::OpenProject(path.clone())}
            else{LibraryEvent::OpenSong{title:SONGS[index].title.into(),artist:SONGS[index].artist.into()}};
        let open_key_event=open_event.clone();
        let delete_event=if let Some(path)=&song.project_dir {LibraryEvent::DeleteProject(path.clone())}
            else{LibraryEvent::DeleteSong{title:song.title.clone().into()}};
        let delete_key_event=delete_event.clone();
        let delete = catalog_project_delete(format!("library-delete:{key:?}"))
            .aria_label(tv("library.dropScreen.deleteAria", &[("name", song.title.to_string())]))
            .track_focus(&delete_focus).tab_index(0)
            .absolute()
            .right(px(7.))
            .top(px(22.5))
            .on_mouse_down(MouseButton::Left,cx.listener(move|_,_,window,cx|mouse_delete.focus(window,cx)))
            .on_key_down(cx.listener(move|_,event:&KeyDownEvent,_,cx|{
                if matches!(event.keystroke.key.as_str(),"enter"|"space") {
                    cx.emit(delete_key_event.clone());cx.stop_propagation();
                }
            }))
            .on_click(cx.listener(move |_, _, _, cx| {
                cx.emit(delete_event.clone());
                cx.stop_propagation();
            }));
        #[cfg(feature = "ui-tests")]
        let delete = if let Some(dir) = song.project_dir.clone() {
            let bounds = self.delete_bounds.clone();
            delete.child(
                canvas(
                    move |b, _, _| {
                        bounds.borrow_mut().insert(dir.clone(), b);
                        b
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
        } else {
            delete
        };
        let (month, day) = song.saved.split_once(' ').unwrap_or(("", ""));
        let meta = format!("{}{} · {day} {month}",
            tn("library.dropScreen.stemsCount", song.stems as f64, &[]),
            if song.lyrics {format!(" · {}",t("library.dropScreen.lyricsBadge"))}else{String::new()});
        let song_label=format!("{} · {}",song.title,meta);
        let card=div()
            .relative()
            .flex_1()
            .min_w_0()
            .h(px(68.))
            .flex_shrink_0()
            .child(
                catalog_project_card(format!("library-song:{key:?}"))
                    .a11y_button(song_label)
                    .track_focus(&open_focus).tab_index(0)
                    .on_mouse_down(MouseButton::Left,cx.listener(move|_,_,window,cx|mouse_open.focus(window,cx)))
                    .on_key_down(cx.listener(move|_,event:&KeyDownEvent,_,cx|{
                        if matches!(event.keystroke.key.as_str(),"enter"|"space") {
                            cx.emit(open_key_event.clone());cx.stop_propagation();
                        }
                    }))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(open_event.clone());
                    }))
                    .child(
                        div()
                            .flex_none()
                            .size(px(44.))
                            .rounded(px(11.))
                            .bg(rgb(0x171310))
                            .flex()
                            .flex_col()
                            .justify_center()
                            .gap(px(3.5))
                            .p(px(9.))
                            .children(hues[palette % 3].into_iter().map(|color| {
                                div()
                                    .h(px(4.5))
                                    .flex_shrink_0()
                                    .w_full()
                                    .rounded(px(2.5))
                                    .bg(rgb(color))
                            })),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(14.5))
                                    .line_height(px(17.5))
                                    .font_family("SingZ Display 700")
                                    .child(singz_uikit::tracked_label(
                                        song.title.clone(),
                                        -0.2 / 14.5,
                                    )),
                            )
                            .child(
                                div()
                                    .text_size(px(11.5))
                                    .line_height(px(14.))
                                    .text_color(rgb(DIM))
                                    .child(meta),
                            ),
                    )
                    .when_some(song.project_dir.as_ref().and_then(|dir| {
                        self.drive.configured.then(||self.drive.projects.get(dir).copied()).flatten()
                            .filter(|state|self.drive.signed_in || *state==crate::drive_state::ProjectState::Syncing)
                    }), |card,state| {
                        use crate::drive_state::ProjectState;
                        let state=match state {
                            ProjectState::Pending=>singz_uikit::DriveBadge::Pending,
                            ProjectState::Syncing=>singz_uikit::DriveBadge::Syncing,
                            ProjectState::Synced=>singz_uikit::DriveBadge::Synced,
                            ProjectState::Blocked=>singz_uikit::DriveBadge::Blocked,
                        };
                        let title=match state {
                            singz_uikit::DriveBadge::Pending=>t("library.dropScreen.waitingTitle"),
                            singz_uikit::DriveBadge::Syncing=>t("library.dropScreen.uploadingTitle"),
                            singz_uikit::DriveBadge::Synced=>t("library.dropScreen.upToDateTitle"),
                            singz_uikit::DriveBadge::Blocked=>tv("library.dropScreen.notOnDriveTitle", &[("reason",self.drive.scheduler.last_error.clone().or_else(||self.drive.error.clone()).unwrap_or_else(||t("library.dropScreen.syncFailedFallback")))]),
                        };
                        let bounds=self.drive_bounds.clone();
                        let id=format!("library-drive-badge-{index}");
                        card.child(singz_uikit::drive_project_badge_title(("library-drive-badge",index),state,title,window)
                            .relative().child(canvas(move |b,_,_|{bounds.borrow_mut().insert(id.clone(),b);b},|_,_,_,_|{}).absolute().inset_0()))
                    }),
            )
            .child(delete);
        #[cfg(feature="ui-tests")]
        let card=card.children(song.project_dir.clone().map(|dir| {
            let bounds=self.project_bounds.clone();
            canvas(move |b,_,_| {bounds.borrow_mut().insert(dir.clone(),b);b},|_,_,_,_|{}).absolute().inset_0()
        }));
        card.into_any_element()
    }

    fn equalizer(time: f32) -> Div {
        div()
            .h(px(110.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .gap(px(3.))
            .children((0..56).map(|i| {
                let delay = (i as f32 * 0.137) % 1.4;
                let elapsed = (time - delay).max(0.) / 1.5;
                let phase = if elapsed as usize % 2 == 0 {
                    elapsed.fract()
                } else {
                    1. - elapsed.fract()
                };
                // CSS ease-in-out = cubic-bezier(.42,0,.58,1).
                let mut lo = 0.;
                let mut hi = 1.;
                for _ in 0..16 {
                    let t = (lo + hi) * 0.5;
                    let x = 3. * (1. - t) * (1. - t) * t * 0.42
                        + 3. * (1. - t) * t * t * 0.58
                        + t * t * t;
                    if x < phase {
                        lo = t;
                    } else {
                        hi = t;
                    }
                }
                let t = (lo + hi) * 0.5;
                // The CSS animation has no backwards fill: before a bar's
                // positive delay it keeps its untransformed full height.
                let scale = if time < delay {
                    1.
                } else {
                    0.3 + 0.7 * (3. * t * t - 2. * t * t * t)
                };
                div().w(px(4.)).h(px(110.)).flex_none().child(
                    canvas(
                        |bounds, _, _| bounds,
                        move |bounds, _, window, _| {
                            let texture = equalizer_primitives()[i].clone();
                            let image_bounds = Bounds::new(
                                point(bounds.left() - px(20.), bounds.center().y - px(67. * scale)),
                                size(px(44.), px(134. * scale)),
                            );
                            let _ = window.paint_image(
                                image_bounds,
                                image_bounds,
                                Corners::default(),
                                texture,
                                0,
                                false,
                            );
                        },
                    )
                    .size_full(),
                )
            }))
    }
}

impl Render for LibraryScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(feature = "ui-tests")]
        self.delete_bounds.borrow_mut().clear();
        #[cfg(feature = "ui-tests")]
        self.project_bounds.borrow_mut().clear();
        self.recover_drive_focus(window,cx);
        // Native Tab can focus a storage action below the page's fold.
        // Reveal only on an actual Drive focus change, using its last measured
        // bounds before clearing them. Keeping the same focus while wheeling
        // must not pin the page back to that action on every render.
        let drive_focus=self.drive_focus.borrow().iter().find(|(id,focus)|
            self.drive_control_enabled(id)&&self.drive_bounds.borrow().contains_key(*id)&&focus.is_focused(window)).map(|(id,_)|id.clone());
        if drive_focus!=self.revealed_drive_focus {
            if let Some(id)=drive_focus.as_deref() {
                if let Some(bounds)=self.drive_bounds(id) {
                    self.reveal_guide(bounds);
                    self.revealed_drive_focus=drive_focus;
                }
            } else {self.revealed_drive_focus=None;}
        }
        self.drive_bounds.borrow_mut().clear();
        let indices=self.filtered_indices();
        #[cfg(feature = "ui-tests")]
        {
            RENDERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if let Ok(mut shown) = LAST_RENDERED_QUERY.lock() { shown.clone_from(&self.query); }
        }
        let focused_card=self.card_focus.borrow().iter().find(|(_,f)|f.is_focused(window)).map(|((key,_),_)|key.clone());
        if focused_card.is_some_and(|key|!indices.iter().any(|index|self.song_key(*index)==key)) {self.focus_search(window,cx);}
        let width = (f32::from(window.viewport_size().width) - 80.)
            .min(880.)
            .max(240.);
        let columns = ((width - 14. + 12.) / 252.).floor().max(1.) as usize;
        let rows: Vec<AnyElement> = indices
            .chunks(columns)
            .enumerate()
            .map(|(row_index, chunk)| {
                let mut row = div().flex().gap(px(12.)).h(px(68.)).flex_shrink_0();
                for (column, &index) in chunk.iter().enumerate() {
                    row = row.child(self.song_card(index, row_index * columns + column, window, cx));
                }
                for _ in chunk.len()..columns {
                    row = row.child(div().flex_1().min_w_0());
                }
                row.into_any_element()
            })
            .collect();
        // Chromium reserves its 10px vertical scrollbar only when content
        // overflows; a single search result keeps only .lib-grid's 4px padding.
        let content_height = if indices.is_empty() {
            12. * 1.6 + 28. // .drop-screen p.fine: line-height1.6 + margin-bottom28.
        } else {
            rows.len() as f32 * 68. + rows.len().saturating_sub(1) as f32 * 12.
        };
        let gutter = if content_height > f32::from(self.scroll.bounds().size.height) {
            10.
        } else {
            0.
        };
        let time = self.animation_time.unwrap_or_else(|| {
            self.suspended_at
                .unwrap_or_else(Instant::now)
                .duration_since(self.animation_epoch)
                .as_secs_f32()
        });
        // The catalog's equalizer is decorative; it has no state transition
        // that requires a continuous display-link request. Its current phase
        // is rendered when the catalog changes and then remains still.
        let native = self.native_catalog();
        let description = match self.open_song.as_ref() {
            Some(song)=>tv("library.dropScreen.catalogHint", &[("song",song.to_string())]),
            None=>t("library.dropScreen.dropHintDesc"),
        };
        let description_height = if self.open_song.is_some() { 72. } else { 48. };
        // Keep the immutable demo reference's min-height:0 negotiation. The
        // real native catalog reserves one complete card row instead: the old
        // zero-height grid at 1060×640 made Open/Delete unreachable. Its section
        // takes an intrinsic, nonshrinking flex basis so the outer page can
        // scroll that row into view. This is a native usability correction,
        // not a pixel-parity claim for the broken reference state.
        div()
            .id("library-screen")
            .key_context("SingZLibrary")
            .on_action(cx.listener(|this,_:&NextCatalogFocus,window,cx|{
                if this.catalog_tab(false,window,cx) {cx.stop_propagation();} else {cx.propagate();}
            }))
            .on_action(cx.listener(|this,_:&PreviousCatalogFocus,window,cx|{
                if this.catalog_tab(true,window,cx) {cx.stop_propagation();} else {cx.propagate();}
            }))
            // Input's more specific Tab binding dispatches an editing action
            // before raw key listeners. Own navigation during action capture
            // so search and cards share the same real keyboard route.
            .capture_action(cx.listener(|this,_:&gpui_kit::component::input::IndentInline,window,cx|{
                if this.catalog_tab(false,window,cx) {cx.stop_propagation();} else {cx.propagate();}
            }))
            .capture_action(cx.listener(|this,_:&gpui_kit::component::input::OutdentInline,window,cx|{
                if this.catalog_tab(true,window,cx) {cx.stop_propagation();} else {cx.propagate();}
            }))
            .track_scroll(&self.page_scroll)
            .w_full()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .font_family("SingZ Display 400")
            .font_weight(FontWeight::NORMAL)
            .text_color(rgb(TEXT))
            .flex()
            .flex_col()
            .items_center()
            .p(px(40.))
            .child(
                div()
                    .w(px(520.))
                    .max_w_full()
                    .h(px(321.5 + description_height))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .items_center()
                    .child(Self::equalizer(time).w_full().mb(px(40.)))
                    .child(
                        div()
                            .w_full()
                            .h(px(62.5))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_center()
                            .text_size(px(52.))
                            .line_height(px(62.5))
                            .font_family("SingZ Display 800")
                            .mb(px(14.))
                            .child(singz_uikit::tracked_text(
                                if self.open_song.is_some() {t("library.dropScreen.yourCatalog")} else {t("library.dropScreen.dropASong")},
                                "SingZ Display 800",
                                52.,
                                -0.52,
                                TEXT,
                            )),
                    )
                    .child(
                        div()
                            .w_full()
                            .h(px(description_height))
                            .text_center()
                            .text_size(px(15.))
                            .line_height(px(24.))
                            .text_color(rgb(DIM))
                            .mb(px(28.))
                            .child(singz_uikit::tracked_label(description, 0.).wrap()),
                    )
                    .child(
                        ghost_pill(
                            "library-browse",
                            t("library.common.browseFiles"),
                        )
                        .text_size(px(14.))
                        .line_height(px(16.5))
                        .h(px(36.5))
                        .flex_shrink_0()
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(LibraryEvent::Browse)))
                        .when(true, |d| self.guides.track_box(d, "browse", [1.; 4])),
                    )
                    .child(
                        div()
                            .mt(px(16.))
                            .text_size(px(12.))
                            .line_height(px(14.5))
                            .text_color(rgb(FAINT))
                            .child(if self.open_song.is_some(){t("library.dropScreen.escHint")}else{t("library.dropScreen.dragHint")}),
                    ),
            )
            .child(
                div()
                    .w(px(width))
                    .mt(px(30.))
                    .pt(px(20.))
                    .border_t_1()
                    .border_color(rgba(0xfff0d614))
                    .flex_1()
                    .min_h_0()
                    .when(native, |section| section.flex_auto().flex_shrink_0())
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .h(px(29.))
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(14.))
                            .mb(px(6.))
                            .child(
                                div()
                                    .mb(px(2.))
                                    .text_size(px(10.5))
                                    .line_height(px(13.))
                                    .font_family("SingZ Display 700")
                                    .text_color(rgb(FAINT))
                                    .child(singz_uikit::tracked_text(
                                        t("library.common.yourProjects").to_uppercase(),
                                        "SingZ Display 700",
                                        10.5,
                                        1.47,
                                        FAINT,
                                    )),
                            )
                            // The production title is width:100%; flex-shrink
                            // resolves its nominal 200px input to this DOM width.
                            .child(catalog_search(&self.search).accessibility_id("library-search").aria_label(crate::i18n::t("library.dropScreen.searchPlaceholder")).w(px(164.671875)).h(px(29.))),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .h(px(53.5))
                            .w_full()
                            .when(true, |d| self.guides.track_box(d, "saved", [1.; 4]))
                            .rounded(px(13.))
                            .border_1()
                            .border_color(rgba(0xffffff0d))
                            .bg(rgba(0xffffff09))
                            .mb(px(14.))
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .px(px(14.))
                            .py(px(10.))
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(6.))
                                            .overflow_hidden()
                                            .whitespace_nowrap()
                                            .h(px(16.5))
                                            .text_size(px(12.5))
                                            .line_height(px(15.))
                                            .text_color(rgb(TEXT))
                                            .opacity(0.9)
                                            // Chromium's emoji fallback advance is exactly one em
                                            // (12.5px); CoreText's color-glyph advance is wider.
                                            // Preserve the source flex-item width without scaling ink.
                                            .child(div().w(px(12.5)).flex_none().child("📁"))
                                            .child(if native {
                                                self.native_root.clone()
                                            } else {
                                                "Demo › SingZ".into()
                                            }),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .line_height(px(13.))
                                            .text_color(rgb(DIM))
                                            .child(if native {
                                                t("library.folders.savedInPlace")
                                            } else {
                                                tv("library.dropScreen.libraryLivesHere", &[("cloud",t("library.dropScreen.cloudLocal"))])
                                            }),
                                    ),
                            )
                            .child(
                                self.guides
                                    .track_box(
                                        text_link("library-storage", t("library.dropScreen.change")),
                                        "storage",
                                        [1.; 4],
                                    )
                                    .on_click(cx.listener(|_, _, _, cx| {
                                        cx.emit(LibraryEvent::ManageStorage)
                                    })),
                            )
                            .when(native && self.drive.configured, |storage| {
                                singz_uikit::drive_storage_panel()
                                    .child(storage.h(px(51.5)).mb_0().border_0().bg(rgba(0)))
                                    .child(self.guides.track_box(self.drive_row(window,cx), "sync", [0., 1., 0., 0.]))
                            })
                            .when_some(
                                self.delete_error.clone().filter(|_| native),
                                |storage, error| {
                                    // The source uses the storage panel's warning sub-row.
                                    // Keep it visible offline as well: its old Drive-only
                                    // condition hid deletion failures without an account.
                                    if self.drive.configured {
                                        storage.child(singz_uikit::library_delete_error(error,window))
                                    } else { div()
                                        .w_full()
                                        .flex_none()
                                        .rounded(px(13.))
                                        .border_1()
                                        .border_color(rgba(0xffffff0d))
                                        .bg(rgba(0xffffff09))
                                        .mb(px(14.))
                                        .child(storage.h(px(51.5)).mb_0().border_0().bg(rgba(0)))
                                        .child(singz_uikit::library_delete_error(error, window)) }
                                },
                            ),
                    )
                    .child(
                        div()
                            .relative()
                            .flex_1()
                            .min_h_0()
                            .when(native, |grid| {
                                grid.min_h(px(if indices.is_empty() { 47.2 } else { 68. }))
                            })
                            .child(
                                div()
                                    .id("library-grid")
                                    .size_full()
                                    .overflow_y_scroll()
                                    .track_scroll(&self.scroll)
                                    .pr(px(gutter + 4.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(12.))
                                    .children(rows)
                                    .when(indices.is_empty(), |d| {
                                        d.child(
                                            div()
                                                .flex_shrink_0()
                                                .w(px((width
                                                    - gutter
                                                    - 4.
                                                    - (columns - 1) as f32 * 12.)
                                                    / columns as f32))
                                                .text_size(px(12.))
                                                .line_height(px(19.2))
                                                .mb(px(28.))
                                                .text_color(rgb(FAINT))
                                                .child(if native && self.query.is_empty() {
                                                    t("library.picker.noPlayable")
                                                } else {
                                                    format!(
                                                        "Nothing matches “{}”.",
                                                        self.query.trim()
                                                    )
                                                }),
                                        )
                                    }),
                            )
                            .child(production_scrollbar(&self.scroll)),
                    ),
            )
    }
}
/// Source driveMsg survives the completed operation for these kinds only. The
/// kind is typed state; the progress text is translated and never compared.
fn drive_keeps_progress(drive: &crate::drive_state::Snapshot) -> bool {
    use crate::drive_state::ProgressKind;
    matches!(drive.progress_kind, ProgressKind::Paused | ProgressKind::SignedOut)
}
#[cfg(test)]
mod drive_progress_tests {
    use super::drive_keeps_progress;
    use crate::drive_state::{ProgressKind, Snapshot};
    #[test]
    fn kept_drive_status_follows_the_typed_kind_in_any_language() {
        let mut drive = Snapshot { progress: "Синхронизация приостановлена.".into(), ..Default::default() };
        assert!(!drive_keeps_progress(&drive));
        drive.progress_kind = ProgressKind::Paused;
        assert!(drive_keeps_progress(&drive));
        drive.progress_kind = ProgressKind::SignedOut;
        assert!(drive_keeps_progress(&drive));
        // English text alone no longer selects the branch.
        let english = Snapshot { progress: "Sync paused. Completed files are kept.".into(), ..Default::default() };
        assert!(!drive_keeps_progress(&english));
        let finishing = Snapshot { progress_kind: ProgressKind::Finishing, ..Default::default() };
        assert!(!drive_keeps_progress(&finishing));
    }
}

/// Catalog events delivered to any library so far (Q-14 times a reload by it).
#[cfg(feature = "ui-tests")]
static CATALOG_DELIVERIES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(feature = "ui-tests")]
pub fn catalog_deliveries() -> u64 { CATALOG_DELIVERIES.load(std::sync::atomic::Ordering::Acquire) }
/// The query of the most recent library render: lets a driver tell which draw first showed a keystroke.
#[cfg(feature = "ui-tests")]
static LAST_RENDERED_QUERY: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
#[cfg(feature = "ui-tests")]
pub fn last_rendered_query() -> String { LAST_RENDERED_QUERY.lock().map(|q| q.clone()).unwrap_or_default() }
#[cfg(feature = "ui-tests")]
static RENDERS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(feature = "ui-tests")]
pub fn renders() -> u64 { RENDERS.load(std::sync::atomic::Ordering::Relaxed) }
