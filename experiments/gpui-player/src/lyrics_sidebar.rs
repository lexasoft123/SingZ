//! Source LyricsPanel controls. The host retains approved native glyph painting.
use crate::i18n::{t,tv,tn};
use crate::{alignmentoutcome_domain::Check, lrclib::Candidate};
use gpui_kit::{
    component::input::{InputEvent, InputState},
    prelude::FluentBuilder,
    *,
};
use singz_uikit as ui;
use std::{cell::RefCell, collections::HashMap, rc::Rc};

actions!(singz_lyrics_sidebar, [Activate]);
#[derive(Clone, Debug)]
pub enum Event {
    Search(String),
    Apply(u64),
    Transcribe,
    Align,
    Precise,
    Edit,
    Download,
    Retry,
    Cancel,
    Changed,
}
#[derive(Clone, Debug, serde::Serialize)]
pub struct Progress {
    pub stage: String,
    pub percent: f32,
}
#[derive(Clone, Debug, serde::Serialize)]
struct Ready {
    source: String,
    credit: Option<String>,
    aligned: bool,
    check: Option<Check>,
}
#[derive(Clone, Debug)]
enum Status {
    Idle,
    Ready(Ready),
    Loading(Option<Progress>),
    Consent { what: String, size_mb: u64 },
    Error(String),
}
pub struct Sidebar {
    songkey: String,
    name: String,
    duration: f64,
    precise_cap: bool,
    status: Status,
    previous: Option<Ready>,
    variants: bool,
    query: Entity<InputState>,
    pending_query: Option<String>,
    results: Option<Vec<Candidate>>,
    busy: bool,
    controls: RefCell<HashMap<String, FocusHandle>>,
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    scroll: ScrollHandle,
    progress_bar: Entity<ui::LyricsSidebarProgress>,
    scope: FocusHandle,
    _input_subscription: Subscription,
}
impl EventEmitter<Event> for Sidebar {}

fn rich_parts(text:&str)->Vec<(String,bool)> {
    let mut parts=Vec::new();let mut rest=text;
    while let Some(start)=rest.find("**") {
        let after=&rest[start+2..];let Some(end)=after.find("**")else{break;};
        if start>0{parts.push((rest[..start].to_owned(),false));}
        parts.push((after[..end].to_owned(),true));rest=&after[end+2..];
    }
    if !rest.is_empty(){parts.push((rest.to_owned(),false));}parts
}
fn check_text(c:&Check)->String {
    let vars=[("pct",c.matched_pct.to_string())];
    if c.verdict=="mismatch"{return tv("lyrics.panel.check.mismatch",&vars);}
    let mut text=tv(if c.verdict=="match"{"lyrics.panel.check.match"}else{"lyrics.panel.check.retimed"},&vars);
    if c.verdict!="match" {
        if c.median_shift.abs()>=0.8{text.push_str(&tv("lyrics.panel.check.timingOff", &[("sec",format!("{:.1}",c.median_shift.abs()))]));}
        if !c.bad_lines.is_empty(){text.push_str(&tn("lyrics.panel.check.lineDiffers",c.bad_lines.len()as f64,&[]));}
        if c.extra_sung&&c.bad_lines.is_empty(){text.push_str(&t("lyrics.panel.check.missingWords"));}
    }
    if c.method=="ctc"{text.push_str(" · precise");}text
}
fn stage(stage: &str) -> String {
    match stage {
        "preparing" => t("lyrics.panel.stage.preparing"),
        "searching" => t("lyrics.panel.stage.searching"),
        "downloading-model" => t("lyrics.panel.stage.downloadingModel"),
        "transcribing" => t("lyrics.panel.stage.transcribing"),
        _ => t("lyrics.panel.stage.starting"),
    }
}
fn time(seconds: f64) -> String {
    let n = seconds.max(0.).floor() as u64;
    format!("{}:{:02}", n / 60, n % 60)
}

impl Sidebar {
    pub fn new(w: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.bind_keys([
            KeyBinding::new("enter", Activate, Some("SingZLyricsSidebarButton")),
            KeyBinding::new("space", Activate, Some("SingZLyricsSidebarButton")),
        ]);
        let query = cx.new(|cx| InputState::new(w, cx).placeholder(t("lyrics.panel.variants.searchPlaceholder")));
        let subscription = cx.subscribe_in(&query, w, |s, _, event, _, cx| match event {
            InputEvent::PressEnter { .. } => s.search(cx),
            InputEvent::Focus | InputEvent::Blur => {
                cx.emit(Event::Changed);
            }
            _ => {}
        });
        Self {
            songkey: String::new(),
            name: String::new(),
            duration: 0.,
            precise_cap: false,
            status: Status::Idle,
            previous: None,
            variants: false,
            query,
            pending_query: None,
            results: None,
            busy: false,
            controls: Default::default(),
            bounds: Default::default(),
            scroll: ScrollHandle::new(),
            progress_bar: cx.new(ui::LyricsSidebarProgress::new),
            scope: cx.focus_handle(),
            _input_subscription: subscription,
        }
    }
    pub fn context(
        &mut self,
        songkey: String,
        name: String,
        duration: f64,
        precise_cap: bool,
        cx: &mut Context<Self>,
    ) {
        let changed = self.songkey != songkey || self.name != name;
        let properties_changed =
            changed || self.duration != duration || self.precise_cap != precise_cap;
        if self.songkey != songkey {
            self.status = Status::Idle;
            self.previous = None;
        }
        self.songkey = songkey;
        self.name = name.clone();
        self.duration = duration;
        self.precise_cap = precise_cap;
        if changed {
            self.variants = false;
            self.pending_query = Some(name);
            self.results = None;
            self.busy = false;
            self.scroll.set_offset(point(px(0.), px(0.)));
        }
        if properties_changed {
            cx.notify();
        }
        if changed {
            cx.emit(Event::Changed);
        }
    }
    /// An owned publication moves the same document; it is not a navigation.
    /// Keep the current lyrics/search/consent state and scroll/focus handles.
    pub fn relocate_owned(
        &mut self,
        previous_key: &str,
        songkey: String,
        name: String,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.songkey != previous_key {
            return false;
        }
        self.songkey = songkey;
        self.name = name;
        self.changed(cx);
        true
    }
    pub fn ready(
        &mut self,
        source: String,
        credit: Option<String>,
        aligned: bool,
        check: Option<Check>,
        cx: &mut Context<Self>,
    ) {
        self.previous = None;
        self.status = Status::Ready(Ready {
            source,
            credit,
            aligned,
            check,
        });
        self.variants = false;
        self.busy = false;
        self.changed(cx);
    }
    pub fn loading(&mut self, progress: Option<Progress>, cx: &mut Context<Self>) {
        if let Status::Ready(ready) = &self.status {
            self.previous = Some(ready.clone());
        }
        let fresh = !matches!(self.status, Status::Loading(_));
        let percent = progress.as_ref().map_or(0., |p| p.percent);
        self.progress_bar
            .update(cx, |s, cx| s.set(percent, fresh, cx));
        self.status = Status::Loading(progress);
        self.variants = false;
        self.changed(cx);
    }
    pub fn consent(&mut self, what: String, size_mb: u64, cx: &mut Context<Self>) {
        if let Status::Ready(ready) = &self.status {
            self.previous = Some(ready.clone());
        }
        self.status = Status::Consent { what, size_mb };
        self.variants = false;
        self.busy = false;
        self.changed(cx);
    }
    pub fn failure(&mut self, msg: String, cx: &mut Context<Self>) {
        self.previous = None;
        self.status = Status::Error(msg);
        self.busy = false;
        self.variants = false;
        self.changed(cx);
    }
    pub fn apply_failure(&mut self, msg: String, cx: &mut Context<Self>) {
        self.previous = None;
        self.status = Status::Error(msg);
        self.busy = false;
        self.changed(cx);
    }
    pub fn idle(&mut self, cx: &mut Context<Self>) {
        self.previous = None;
        self.status = Status::Idle;
        self.variants = false;
        self.busy = false;
        self.changed(cx);
    }
    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        if matches!(self.status, Status::Loading(_) | Status::Consent { .. }) {
            self.status = self
                .previous
                .take()
                .map(Status::Ready)
                .unwrap_or(Status::Idle);
        } else {
            self.previous = None;
        }
        self.variants = false;
        self.busy = false;
        self.changed(cx);
    }
    pub fn abandon_apply(&mut self,cx:&mut Context<Self>){self.busy=false;self.changed(cx);}
    pub fn is_ready(&self) -> bool {
        matches!(self.status, Status::Ready(_))
    }
    pub fn is_loading(&self) -> bool {
        matches!(self.status, Status::Loading(_))
    }
    pub fn search_results(&mut self, results: Vec<Candidate>, cx: &mut Context<Self>) {
        self.results = Some(results);
        self.busy = false;
        self.changed(cx);
    }
    pub fn shows_lyrics(&self) -> bool {
        !self.variants && matches!(self.status, Status::Ready(_))
    }
    pub fn is_whisper(&self) -> bool {
        matches!(&self.status,Status::Ready(r)if r.source=="whisper")
    }
    pub fn search_input(&self) -> Entity<InputState> {
        self.query.clone()
    }
    pub fn input_focused(&self, w: &Window, cx: &App) -> bool {
        self.query.read(cx).focus_handle(cx).is_focused(w)
    }
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.bounds.borrow().get(id).copied()
    }
    pub fn state(&self, w: &Window, cx: &App) -> serde_json::Value {
        let (status, details) = match &self.status {
            Status::Idle => ("idle", serde_json::json!({})),
            Status::Ready(r) => (
                "ready",
                serde_json::json!({"source":r.source,"credit":r.credit,"aligned":r.aligned,"check":r.check}),
            ),
            Status::Loading(p) => ("loading", serde_json::json!({"progress":p})),
            Status::Consent { what, size_mb } => {
                ("consent", serde_json::json!({"what":what,"sizeMb":size_mb}))
            }
            Status::Error(e) => ("error", serde_json::json!({"error":e})),
        };
        serde_json::json!({"songkey":self.songkey,"name":self.name,"duration":self.duration,"preciseCap":self.precise_cap,"status":status,"details":details,
            "view":if self.variants{"variants"}else{"lyrics"},"showsLyrics":self.shows_lyrics(),"query":self.query.read(cx).value().to_string(),"results":self.results,"busy":self.busy,
            "previous":self.previous,"inputFocused":self.input_focused(w,cx),"focusInside":self.scope.contains_focused(w,cx),"focusedControl":self.controls.borrow().iter().find(|(_,f)|f.is_focused(w)).map(|(id,_)|id.clone()),
            "barPercent":self.progress_bar.read(cx).percent(),
            "scrollOffset":[f32::from(self.scroll.offset().x),f32::from(self.scroll.offset().y)]})
    }
    fn changed(&self, cx: &mut Context<Self>) {
        cx.notify();
        cx.emit(Event::Changed);
    }
    fn search(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let query = self
            .pending_query
            .as_ref()
            .cloned()
            .unwrap_or_else(|| self.query.read(cx).value().to_string());
        self.results = None;
        self.busy = true;
        cx.emit(Event::Search(
            crate::lyrics_edit::trim_text(&query).to_owned(),
        ));
        self.changed(cx);
    }
    fn variants(&mut self, cx: &mut Context<Self>) {
        self.variants = true;
        self.scroll.set_offset(point(px(0.), px(0.)));
        if self.results.is_none() && !self.busy {
            self.search(cx);
        }
        self.changed(cx);
    }
    fn activate(&mut self, id: &str, cx: &mut Context<Self>) {
        match id {
            "lyrics-change" | "lyrics-manual" => self.variants(cx),
            "lyrics-back" => {
                self.variants = false;
                self.changed(cx);
            }
            "lyrics-search" => self.search(cx),
            "lyrics-transcribe" => {
                self.variants = false;
                cx.emit(Event::Transcribe);
                self.changed(cx);
            }
            "lyrics-align" => cx.emit(Event::Align),
            "lyrics-precise" => cx.emit(Event::Precise),
            "lyrics-edit" => cx.emit(Event::Edit),
            "lyrics-download" => cx.emit(Event::Download),
            "lyrics-retry" => cx.emit(Event::Retry),
            "lyrics-cancel" => cx.emit(Event::Cancel),
            _ => {
                if let Some(id) = id
                    .strip_prefix("lyrics-variant-")
                    .and_then(|id| id.parse::<u64>().ok())
                {
                    if !self.busy
                        && self
                            .results
                            .as_ref()
                            .is_some_and(|r| r.iter().any(|c| c.id == id && c.synced))
                    {
                        self.busy = true;
                        cx.emit(Event::Apply(id));
                        self.changed(cx);
                    }
                }
            }
        }
    }
    fn probe(&self, id: &str, d: Stateful<Div>) -> Stateful<Div> {
        let id = id.to_owned();
        let bounds = self.bounds.clone();
        d.relative().child(
            canvas(
                move |b, _, _| {
                    bounds.borrow_mut().insert(id.clone(), b);
                    b
                },
                |_, _, _, _| {},
            )
            .absolute()
            .inset_0(),
        )
    }
    pub fn refresh_locale(&mut self,w:&mut Window,cx:&mut Context<Self>) {
        self.query.update(cx,|input,cx|input.set_placeholder(t("lyrics.panel.variants.searchPlaceholder"),w,cx));
        cx.notify();
    }
    fn link(&self,id:&str,label:impl Into<SharedString>,cx:&mut Context<Self>)->Stateful<Div> {
        self.control(id,ui::lyrics_sidebar_link(id.to_owned(),label,true),true,cx)
    }
    fn button(&self,id:&str,label:impl Into<SharedString>,primary:bool,small:bool,enabled:bool,cx:&mut Context<Self>)->Stateful<Div> {
        self.control(id,ui::lyrics_sidebar_button(id.to_owned(),label,primary,small,enabled),enabled,cx)
    }
    fn control(
        &self,
        id: &str,
        d: Stateful<Div>,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let focus = self
            .controls
            .borrow_mut()
            .entry(id.into())
            .or_insert_with(|| cx.focus_handle().tab_stop(true))
            .clone();
        let click_id = id.to_owned();
        self.probe(
            id,
            d.when(enabled, |d| {
                ui::lyrics_sidebar_focus(d, focus.clone())
                    .track_focus(&focus)
                    .key_context("SingZLyricsSidebarButton")
            })
            .on_click(cx.listener(move |s, _, _, cx| {
                if enabled {
                    s.activate(&click_id, cx);
                }
                cx.stop_propagation();
            })),
        )
    }
}
impl Render for Sidebar {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(query) = self.pending_query.take() {
            self.query.update(cx, |s, cx| s.set_value(query, w, cx));
        }
        self.bounds.borrow_mut().clear();
        let mut root = div()
            .flex()
            .flex_col()
            .min_h_0()
            .font_family(ui::tokens::DISPLAY_400)
            .font_weight(FontWeight::NORMAL)
            .track_focus(&self.scope)
            .tab_group()
            .tab_stop(false)
            .on_action(cx.listener(|s, _: &Activate, w, cx| {
                let id = s
                    .controls
                    .borrow()
                    .iter()
                    .find(|(_, f)| f.is_focused(w))
                    .map(|(id, _)| id.clone());
                if let Some(id) = id {
                    s.activate(&id, cx);
                    cx.stop_propagation();
                }
            }));
        if self.shows_lyrics() {
            if let Status::Ready(r) = &self.status {
                let credit = if r.source == "lrclib" {
                    r.credit.clone().unwrap_or_else(|| "LRCLIB".into())
                } else if r.source == "edited" {
                    r.credit.clone().unwrap_or_else(|| t("lyrics.panel.credit.own").into())
                } else {
                    t("lyrics.panel.credit.vocals").into()
                };
                let mut source = ui::lyrics_sidebar_source(w)
                    .child(ui::lyrics_sidebar_badge_label(&r.source,t(match r.source.as_str(){"lrclib"=>"lyrics.panel.source.synced","edited"=>"lyrics.panel.source.edited",_=>"lyrics.panel.source.aiTranscribed"})))
                    .child(ui::lyrics_sidebar_credit(format!(
                        "{credit}{}",
                        if r.aligned { t("lyrics.panel.credit.aiAligned") } else { String::new() }
                    )));
                if r.source != "whisper" {
                    source = source.child(self.link("lyrics-align", t("lyrics.panel.checkAlign.label"), cx));
                    if self.precise_cap {
                        source = source.child(self.link("lyrics-precise", t("lyrics.panel.precise.label"), cx));
                    }
                }
                source = source
                    .child(self.link("lyrics-edit", t("lyrics.panel.edit.label"), cx))
                    .child(self.link("lyrics-change", t("lyrics.panel.change.label"), cx));
                root = root
                    .flex_shrink_0()
                    .child(self.probe("lyrics-source", source.id("lyrics-source")));
                if let Some(check) = &r.check {
                    root = root.child(
                        self.probe(
                            "lyrics-check",
                            ui::lyrics_sidebar_check(
                                check_text(check),
                                check.verdict == "mismatch",
                                w,
                            )
                            .id("lyrics-check"),
                        ),
                    );
                }
            }
        } else {
            root = root.flex_1();
            let mut body = ui::lyrics_sidebar_body("lyrics-body", w.viewport_size().height)
                .track_scroll(&self.scroll);
            if self.variants {
                let mut variants = ui::lyrics_sidebar_variants()
                    .child(
                        ui::lyrics_sidebar_variants_top()
                            .child(self.control(
                                "lyrics-back",
                                ui::lyrics_sidebar_chip("lyrics-back", t("lyrics.panel.variants.back")),
                                true,
                                cx,
                            ))
                            .child(self.control(
                                "lyrics-transcribe",
                                ui::lyrics_sidebar_chip("lyrics-transcribe", t("lyrics.panel.variants.aiTranscribeLabel")),
                                true,
                                cx,
                            )),
                    )
                    .child(
                        ui::lyrics_sidebar_search_row()
                            .child(self.probe(
                                "lyrics-query",
                                div().id("lyrics-query").flex_1().min_w_0().child(
                                    ui::lyrics_sidebar_search_input(
                                        &self.query,
                                        self.input_focused(w, cx),
                                    )
                                    .accessibility_id("lyrics-search")
                                    .aria_label(t("lyrics.panel.variants.searchPlaceholder")),
                                ),
                            ))
                            .child(self.button("lyrics-search",
                                if self.busy { "…".to_owned() } else { t("lyrics.panel.variants.searchLabel") },
                                false,
                                true,
                                !self.busy,
                                cx,
                            )),
                    );
                if let Some(results) = &self.results {
                    if results.is_empty() {
                        variants = variants.child(ui::lyrics_sidebar_variant_empty_text(t("lyrics.panel.variants.nothingFound"),w));
                    }
                    for c in results {
                        let id = format!("lyrics-variant-{}", c.id);
                        let enabled = c.synced && !self.busy;
                        let meta = format!(
                            "{}{}{}",
                            time(c.duration),
                            if (c.duration - self.duration).abs() <= 3. {
                                t("lyrics.panel.variants.matches")
                            } else {
                                String::new()
                            },
                            if c.synced {
                                t("lyrics.panel.variants.synced")
                            } else {
                                t("lyrics.panel.variants.textOnly")
                            }
                        );
                        variants = variants.child(
                            self.control(
                                &id,
                                ui::lyrics_sidebar_variant(id.clone(), enabled)
                                    .child(ui::lyrics_sidebar_variant_main(&c.track, &c.artist, w))
                                    .child(ui::lyrics_sidebar_variant_meta(meta)),
                                enabled,
                                cx,
                            ),
                        );
                    }
                }
                body = body.child(variants);
            } else {
                let mut state = ui::lyrics_sidebar_state();
                match &self.status {
                    Status::Loading(progress) => {
                        let label = format!(
                            "{}…",
                            stage(progress.as_ref().map_or("", |p| p.stage.as_str()))
                        );
                        let percent = progress
                            .as_ref()
                            .filter(|p| p.stage != "searching")
                            .map(|p| format!("{}%", p.percent.round()))
                            .unwrap_or_default();
                        state = state
                            .child(ui::lyrics_sidebar_loading(label, percent))
                            .child(self.progress_bar.clone())
                            .child(self.button("lyrics-cancel",
                                t("lyrics.panel.loading.cancel"),
                                false,
                                true,
                                true,
                                cx,
                            ));
                    }
                    Status::Consent { what, size_mb } => {
                        let aligner = what == "aligner";
                        let parts=rich_parts(&t(if aligner{"lyrics.panel.consent.alignerText"}else{"lyrics.panel.consent.qwenText"}));
                        state=state.child(ui::lyrics_sidebar_rich(parts)).child(ui::lyrics_sidebar_fine(tv("lyrics.panel.consent.fineprint", &[("mb",size_mb.to_string())]),false))
                            .child(self.button("lyrics-download",if aligner{t("lyrics.panel.consent.downloadAlignLabel")}else{t("lyrics.panel.consent.downloadContinueLabel")},true,false,true,cx))
                            .child(self.link("lyrics-manual",t("lyrics.panel.consent.searchManually"),cx));
                    }
                    Status::Error(error) => {
                        state = state
                            .child(ui::lyrics_sidebar_fine(error.clone(), true))
                            .child(self.button("lyrics-retry",
                                t("lyrics.panel.error.tryAgain"),
                                false,
                                false,
                                true,
                                cx,
                            ))
                            .child(self.link("lyrics-manual",
                                t("lyrics.panel.error.searchManually"),
                                cx,
                            ))
                            .child(self.link("lyrics-edit",
                                t("lyrics.panel.error.writeYourself"),
                                cx,
                            ));
                    }
                    Status::Idle | Status::Ready(_) => {}
                }
                if !matches!(self.status, Status::Idle) {
                    body = body.child(state);
                }
            }
            root = root.child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .child(self.probe("lyrics-body", body))
                    .child(ui::production_scrollbar(&self.scroll)),
            );
        }
        root
    }
}
