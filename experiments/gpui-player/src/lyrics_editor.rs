//! Native source-backed lyrics draft editor. Audio and persistence are host-owned.
use crate::lyrics_edit::{self as edit, DraftRow, Line, RowEdit, StripWindow, Word};
use gpui_kit::{component::input::{InputEvent, InputState, TextareaState}, prelude::FluentBuilder, *};
use singz_uikit::{self as ui, tokens::*};
use std::{cell::{Cell, RefCell}, collections::HashMap, rc::Rc, sync::Arc, time::Instant};
actions!(singz_lyrics_editor,[NextFocus,PreviousFocus]);

pub fn copy(key: &str) -> String {
    crate::i18n::t(&format!("lyrics.editor.{key}"))
}
#[derive(Clone, Debug)]
pub enum Event {
    Save(Vec<Line>,u64), Align(bool, bool), CancelAlign, Close, Play,
    Seek { position: f64, play: bool },
}
struct RowInput { input: Entity<InputState>, _subscription: Subscription }
#[derive(Clone, Copy)]
struct Drag { row: u64, index: usize, time: f64, grab: f64 }
// This entity alone animates: rebuilding all draft inputs or repainting the
// player at display cadence would make an editor cursor disproportionately costly.
#[derive(Clone, Copy, Debug, PartialEq)]
struct DisplayClock {
    position: f64, duration: f64, playing: bool,
    anchor: Option<(f64, Instant)>, rate: f64, loop_range: Option<(f64, f64)>,
}
impl DisplayClock {
    fn position_at(self, now: Instant) -> f64 {
        let mut position = self.position;
        if self.playing {
            if let Some((source, sampled_at)) = self.anchor {
                // Never renew the source timestamp on a render: stalled telemetry
                // must freeze at the same 100ms authority limit as the host.
                position = source + now.saturating_duration_since(sampled_at).as_secs_f64().min(0.1) * self.rate;
                if let Some((start,end)) = self.loop_range {
                    if start.is_finite() && end.is_finite() && end > start && position >= end {
                        position = start + (position-end) % (end-start);
                    }
                }
            }
        }
        position.clamp(0.,self.duration.max(0.))
    }
    fn advancing(self, now: Instant) -> bool {
        self.playing && self.rate > 0. && self.anchor.is_some_and(|(_,at)|
            now.saturating_duration_since(at).as_secs_f64() < 0.1)
            && self.position_at(now) < self.duration
    }
}
struct StripPlayhead {
    clock: DisplayClock, strip: Option<StripWindow>, frame_pending: bool,
}
impl Render for StripPlayhead {
    fn render(&mut self,w:&mut Window,cx:&mut Context<Self>)->impl IntoElement {
        let now=Instant::now();
        if self.strip.is_some() && self.clock.advancing(now) && !self.frame_pending {
            self.frame_pending=true;
            let weak=cx.weak_entity();
            w.on_next_frame(move|_,cx|{let _=weak.update(cx,|s,cx|{s.frame_pending=false;cx.notify();});});
            w.request_animation_frame();
        }
        let head=self.strip.map(|strip|(self.clock.position_at(now)-strip.t0)/(strip.t1-strip.t0).max(0.001));
        div().absolute().inset_0().when_some(head.filter(|h|(0. ..=1.).contains(h)),|d,head|
            d.child(ui::lyrics_editor_word_playhead().left(relative(head as f32))))
    }
}
pub struct Editor {
    rows: Vec<DraftRow>, inputs: HashMap<u64, RowInput>, history: edit::History,
    input_copy: Option<(crate::i18n::Locale, usize)>,
    revision:u64, pending_control:Option<String>, pub dirty: bool, pub saving: bool, pub busy: bool, pub error: Option<String>, pub notice: Option<String>,
    pub help: bool, pub replace: bool, pub discard: bool, pub strip: Option<StripWindow>,
    name: String, position: f64, duration: f64, playing: bool, precise: bool,
    playhead: Entity<StripPlayhead>,
    progress: Option<(String, f32)>, consent: Option<(bool, u64, bool)>, check: Option<edit::AlignCheck>,
    coarse: Option<Arc<edit::VocalEnvelope>>, fine: Option<Arc<edit::VocalEnvelope>>,
    replacement: Entity<TextareaState>, pending_replacement: Option<String>,
    scope: FocusHandle, focused_row: Option<u64>, pending_focus: Option<edit::FocusTarget>,
    text_group: Option<u64>, focus_controls: RefCell<HashMap<String, FocusHandle>>,
    order: RefCell<Vec<String>>, keyboard: Rc<Cell<bool>>, bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    scroll: ScrollHandle, help_scroll: ScrollHandle, drag: Option<Drag>,
}
impl EventEmitter<Event> for Editor {}
impl Editor {
    pub fn new(w: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.bind_keys([KeyBinding::new("tab",NextFocus,Some("SingZLyricsEditor")),KeyBinding::new("shift-tab",PreviousFocus,Some("SingZLyricsEditor"))]);
        let playhead=cx.new(|_|StripPlayhead {clock:DisplayClock {position:0.,duration:0.,playing:false,anchor:None,rate:1.,loop_range:None},strip:None,frame_pending:false});
        Self { input_copy:None, playhead, rows: vec![edit::empty_row()], inputs: HashMap::new(), history: Default::default(),
            revision:0,pending_control:None,dirty:false,saving:false,busy:false,error:None,notice:None,help:false,replace:false,discard:false,strip:None,
            name:String::new(),position:0.,duration:0.,playing:false,precise:false,progress:None,consent:None,check:None,
            coarse:None,fine:None,replacement:cx.new(|cx|TextareaState::new(w,cx)),pending_replacement:None,
            scope:cx.focus_handle(),focused_row:None,pending_focus:None,text_group:None,
            focus_controls:Default::default(),order:Default::default(),keyboard:Rc::new(Cell::new(false)),
            bounds:Default::default(),scroll:ScrollHandle::new(),help_scroll:ScrollHandle::new(),drag:None }
    }
    pub fn open(&mut self, name:String, lines:Vec<Line>, duration:f64, precise:bool, cx:&mut Context<Self>) {
        self.rows=edit::rows_from_lines(&lines);if self.rows.is_empty(){self.rows.push(edit::empty_row());}
        self.name=name;self.duration=duration;self.precise=precise;self.inputs.clear();self.input_copy=None;self.history=Default::default();
        self.revision=0;self.pending_control=None;self.dirty=false;self.saving=false;self.busy=false;self.error=None;self.notice=None;self.help=false;self.replace=false;
        self.discard=false;self.strip=None;self.drag=None;self.progress=None;self.consent=None;self.check=None;
        self.coarse=None;self.fine=None;self.text_group=None;self.focused_row=None;
        self.pending_focus=Some(edit::FocusTarget{id:self.rows[0].id,caret_utf16:None});
        self.scroll.set_offset(point(px(0.),px(0.)));cx.notify();
    }
    pub fn set_notice(&mut self, notice:Option<String>, cx:&mut Context<Self>){self.notice=notice;cx.notify();}
    pub fn context(&mut self, position:f64, duration:f64, playing:bool, cx:&mut Context<Self>) {
        self.context_playback(position,duration,playing,None,1.,None,cx);
    }
    /// `anchor` must carry the original native sample timestamp. Supplying a
    /// render timestamp would falsely extend stale audio authority. None freezes.
    pub fn context_playback(&mut self, position:f64, duration:f64, playing:bool,
        anchor:Option<(f64,Instant)>,rate:f64,loop_range:Option<(f64,f64)>,cx:&mut Context<Self>) {
        let clock=DisplayClock {position,duration,playing,
            anchor:anchor.filter(|(p,_)|p.is_finite()),rate:if rate.is_finite(){rate.max(0.)}else{0.},loop_range};
        self.playhead.update(cx,|s,cx|if s.clock!=clock{s.clock=clock;cx.notify();});
        if (self.position*10.).floor()!=(position*10.).floor() || self.playing!=playing || self.duration!=duration {
            self.position=position;self.duration=duration;self.playing=playing;cx.notify();
        } else {self.position=position;self.duration=duration;}
    }
    pub fn envelopes(&mut self, coarse:Arc<edit::VocalEnvelope>, fine:Arc<edit::VocalEnvelope>, cx:&mut Context<Self>) {
        self.coarse=Some(coarse);self.fine=Some(fine);cx.notify();
    }
    pub fn saved(&mut self, error:Option<String>, cx:&mut Context<Self>) {
        self.saving=false;self.error=error;if self.error.is_none(){self.dirty=false;cx.emit(Event::Close);}cx.notify();
    }
    pub fn saved_revision(&mut self, revision:u64, error:Option<String>, cx:&mut Context<Self>){
        if error.is_none()&&revision!=self.revision {
            self.saving=false;self.error=Some(crate::i18n::t("lyrics.editor.earlierDraftSaved"));self.dirty=true;cx.notify();
        }else{self.saved(error,cx);}
    }
    pub fn alignment_progress(&mut self, label:String, percent:f32, cx:&mut Context<Self>) {
        self.busy=true;self.progress=Some((label,percent));cx.notify();
    }
    pub fn needs_model(&mut self, precise:bool, mb:u64, aligner:bool, cx:&mut Context<Self>) {
        self.busy=false;self.progress=None;self.consent=Some((precise,mb,aligner));cx.notify();
    }
    pub fn aligned(&mut self, lines:Option<Vec<Line>>, check:Option<edit::AlignCheck>, error:Option<String>, cx:&mut Context<Self>) {
        self.busy=false;self.progress=None;self.error=error;self.check=check;
        if let Some(lines)=lines {self.history.snapshot(&self.rows);self.rows=edit::rows_from_lines(&lines);self.dirty=true;self.revision+=1;self.strip=None;}
        cx.notify();
    }
    pub fn revision(&self)->u64{self.revision}
    pub fn precise_cap(&mut self,precise:bool,cx:&mut Context<Self>){if self.precise!=precise{self.precise=precise;cx.notify();}}
    pub fn rows(&self)->&[DraftRow]{&self.rows}
    pub fn input(&self,id:u64)->Option<Entity<InputState>>{self.inputs.get(&id).map(|r|r.input.clone())}
    pub fn replacement_input(&self)->Entity<TextareaState>{self.replacement.clone()}
    /// The host must suppress workspace shortcuts without consuming printable
    /// KeyDown events, which still need to reach the native text input handler.
    pub fn text_input_focused(&self,w:&Window,cx:&App)->bool {
        if self.help||self.discard{return false;}
        if self.replace {self.replacement.read(cx).focus_handle(cx).is_focused(w)}
        else {self.inputs.values().any(|row|row.input.read(cx).focus_handle(cx).is_focused(w))}
    }
    pub fn bounds(&self,id:&str)->Option<Bounds<Pixels>>{if id=="lyed-list"{Some(self.scroll.bounds())}else{self.bounds.borrow().get(id).copied()}}
    pub fn state(&self,w:&Window,cx:&App)->serde_json::Value {
        serde_json::json!({"revision":self.revision,"rows":self.rows,"dirty":self.dirty,"saving":self.saving,"busy":self.busy,"error":self.error,
            "help":self.help,"replace":self.replace,"discard":self.discard,"strip":self.strip,"focusedRow":self.rows.iter().find(|row|self.input(row.id).is_some_and(|input|input.read(cx).focus_handle(cx).is_focused(w))).map(|row|row.id),"focusEventRow":self.focused_row,
            "focusInside":self.scope.contains_focused(w,cx),"position":self.position,"playing":self.playing,
            "displayPosition":self.playhead.read(cx).clock.position_at(Instant::now()),
            "displayAnimating":self.playhead.read(cx).strip.is_some()&&self.playhead.read(cx).clock.advancing(Instant::now()),
            "progress":self.progress,"consent":self.consent,"check":self.check,
            "textInputFocused":self.text_input_focused(w,cx),"focusOrder":self.order.borrow().clone(),"focusedControl":self.focused_item(w,cx)})
    }
    fn apply(&mut self, edit:Option<RowEdit>, cx:&mut Context<Self>) {
        if let Some(edit)=edit {self.history.snapshot(&self.rows);self.rows=edit.rows;self.pending_focus=edit.focus;
            self.dirty=true;self.revision+=1;self.check=None;self.error=None;self.text_group=None;cx.notify();}
    }
    fn change_words(&mut self,id:u64, words:Vec<Word>, cx:&mut Context<Self>) {
        if self.rows.iter().find(|r|r.id==id).is_some_and(|r|r.words.as_ref()==Some(&words)){return;}
        let rows=self.rows.iter().map(|r|if r.id==id {edit::with_words(r,words.clone())}else{r.clone()}).collect();
        self.apply(Some(RowEdit{rows,focus:None}),cx);
    }
    fn words(&self,id:u64)->Vec<Word>{self.rows.iter().find(|r|r.id==id).map(|r| {
        if edit::words_match_text(r){r.words.clone().unwrap()}else{let s=r.start.unwrap_or(0.);edit::distribute_row_words(&r.text,s,r.end.unwrap_or_else(||edit::estimate_line_end(&r.text,s)))}
    }).unwrap_or_default()}
    fn toggle_strip(&mut self,id:u64,cx:&mut Context<Self>){
        if self.strip.as_ref().is_some_and(|s|s.id==id){self.strip=None;}else{self.strip=edit::strip_window(&self.rows,id,self.duration);}
        self.drag=None;cx.notify();
    }
    pub fn request_close(&mut self,cx:&mut Context<Self>){
        if self.saving{return;}
        if self.help{self.help=false;self.pending_control=Some("lyed-help".into());}else if self.strip.is_some(){self.strip=None;self.drag=None;}
        else if self.busy{return;}else if self.dirty{self.discard=true;self.pending_control=Some("lyed-keep".into());}else{cx.emit(Event::Close);}
        cx.notify();
    }
    fn activate(&mut self,id:&str,w:&mut Window,cx:&mut Context<Self>){
        match id {
            "lyed-play"=>cx.emit(Event::Play),
            "lyed-help"=>{self.help_scroll.set_offset(point(px(0.),px(0.)));self.help=true;self.keyboard.set(true);self.pending_control=Some("lyed-help-close".into());},
            "lyed-help-close"=>{self.help=false;self.pending_control=Some("lyed-help".into());},
            "lyed-cancel"=>self.request_close(cx),
            "lyed-keep"=>self.discard=false,
            "lyed-discard"=>cx.emit(Event::Close),
            "lyed-save" if !self.saving&&!self.busy=>{
                let lines=edit::lines_from_rows(&self.rows,self.duration);
                if lines.is_empty(){self.error=Some(crate::i18n::t("lyrics.editor.noLines"));}else{self.saving=true;self.error=None;cx.emit(Event::Save(lines,self.revision));}
            }
            "lyed-undo"=>{if let Some(rows)=self.history.undo(&self.rows){self.rows=rows;self.dirty=true;self.revision+=1;self.text_group=None;}},
            "lyed-replace" if !self.busy&&!self.saving=>{
                self.pending_replacement=Some(self.rows.iter().map(|r|r.text.as_str()).filter(|t|!edit::trim_text(t).is_empty()).collect::<Vec<_>>().join("\n"));self.replace=true;
            }
            "lyed-replace-cancel"=>self.replace=false,
            "lyed-replace-apply"=>{
                match edit::replace_all_text(&self.rows,&self.replacement.read(cx).value().to_string()){
                    Ok(rows)=>{self.apply(Some(RowEdit{rows,focus:None}),cx);self.replace=false;},Err(e)=>self.error=Some(e.to_string())}
            }
            "lyed-align"|"lyed-precise" if !self.busy&&!self.saving=>{self.busy=true;self.error=None;self.consent=None;cx.emit(Event::Align(id=="lyed-precise",false));}
            "lyed-align-download"=>{if let Some((precise,_,_))=self.consent.take(){self.busy=true;cx.emit(Event::Align(precise,true));}},
            "lyed-align-not-now"=>self.consent=None,
            "lyed-align-cancel"=>cx.emit(Event::CancelAlign),
            "lyed-drop-silent"=>{let silent=edit::silent_row_ids(&self.rows,self.coarse.as_deref());self.apply(edit::drop_silent(&self.rows,&silent),cx);},
            _=>{
                if let Some((kind,number))=id.rsplit_once('-') {if let Ok(row)=number.parse::<u64>(){match kind {
                    "lyed-add"=>self.apply(edit::add_row_after(&self.rows,row),cx),
                    "lyed-remove"=>self.apply(edit::delete_row(&self.rows,row),cx),
                    "lyed-print"=>self.toggle_strip(row,cx),
                    "lyed-stamp"=>{
                        if let Some(s)=self.rows.iter().find(|r|r.id==row).and_then(|r|r.start){cx.emit(Event::Seek{position:(s-0.3).max(0.),play:true});}
                        else{self.apply(edit::stamp_row(&self.rows,row,self.position),cx);}
                    }
                    _=>{}
                }}}
            }
        }
        let _=w;cx.notify();
    }
    fn ensure_inputs(&mut self,w:&mut Window,cx:&mut Context<Self>){
        let key=(crate::i18n::current(),self.rows.len());
        let refresh=self.input_copy!=Some(key);
        if refresh {
            self.replacement.update(cx,|s,cx|s.set_placeholder(copy("replace.placeholder"),w,cx));
            self.input_copy=Some(key);
        }
        self.inputs.retain(|id,_|self.rows.iter().any(|r|r.id==*id));
        for row in &self.rows {
            if !self.inputs.contains_key(&row.id){
                let id=row.id;let input=cx.new(|cx|InputState::new(w,cx).placeholder(if self.rows.len()==1 {copy("row.placeholder")} else {String::new()}));
                let subscription=cx.subscribe_in(&input,w,move|s,_,event,_,cx|match event {
                    InputEvent::Focus=>{s.focused_row=Some(id);s.text_group=None;cx.notify();},
                    InputEvent::Blur=>{if s.focused_row==Some(id){s.focused_row=None;s.text_group=None;}cx.notify();},
                    InputEvent::Change=>{
                        let value=s.inputs.get(&id).unwrap().input.read(cx).value().to_string();
                        if let Some(changed)=edit::set_text(&s.rows,id,value){
                            if s.text_group!=Some(id){s.history.snapshot(&s.rows);s.text_group=Some(id);}
                            s.rows=changed.rows;s.dirty=true;s.revision+=1;s.check=None;s.error=None;cx.notify();
                        }
                    },
                    _=>{}
                });
                self.inputs.insert(id,RowInput{input,_subscription:subscription});
            }
            let input=self.inputs[&row.id].input.clone();
            if refresh {input.update(cx,|s,cx|s.set_placeholder(if self.rows.len()==1 {copy("row.placeholder")} else {String::new()},w,cx));}
            if input.read(cx).value().as_str()!=row.text {input.update(cx,|s,cx|s.set_value(row.text.clone(),w,cx));}
        }
        if let Some(value)=self.pending_replacement.take(){self.replacement.update(cx,|s,cx|{s.set_value(value,w,cx);s.focus(w,cx);});}
        if let Some(focus)=self.pending_focus.take(){self.scroll_row(focus.id,false);if let Some(input)=self.input(focus.id){input.update(cx,|s,cx|{
            s.focus(w,cx);if let Some(pos)=focus.caret_utf16 {let byte=edit::byte_at_utf16(&s.value(),pos);s.set_selected_range(byte..byte,cx);}
        });}}
    }
    fn probe(&self,id:&str,d:Stateful<Div>)->Stateful<Div>{
        self.probe_positioned(id,d.relative())
    }
    fn probe_positioned(&self,id:&str,d:Stateful<Div>)->Stateful<Div>{
        let id=id.to_owned();let bounds=self.bounds.clone();
        d.child(canvas(move|b,_,_|{bounds.borrow_mut().insert(id.clone(),b);b},|_,_,_,_|{}).absolute().inset_0())
    }
    fn button(&self,id:String,d:Stateful<Div>,enabled:bool,tab:bool,cx:&mut Context<Self>)->Stateful<Div>{
        let focus=self.focus_controls.borrow_mut().entry(id.clone()).or_insert_with(||cx.focus_handle()).clone();
        if enabled&&tab {self.order.borrow_mut().push(id.clone());}
        let click_id=id.clone();
        // Row buttons are icon-like; the id says which, so a name is derived from it.
        let name=["stamp-","print-","add-","remove-"].iter().find_map(|p|id.strip_prefix(&format!("lyed-{p}")).map(|_|match *p{
            "stamp-"=>copy("row.stampTitleTimed"),"print-"=>copy("row.printTitleTimed"),"add-"=>copy("row.addTitle"),_=>copy("row.removeTitle")}));
        let name=name.or_else(||match id.as_str(){
            "lyed-play"=>Some(copy(if self.playing{"pause"}else{"play"})),"lyed-help"=>Some(copy("helpTitle")),
            "lyed-cancel"=>Some(copy("cancel")),"lyed-save"=>Some(copy(if self.saving{"save.saving"}else{"save.label"})),_=>None});
        let d=match name{Some(name)=>crate::a11y::ButtonSurface::a11y_button(d,name),None=>d};
        self.probe(&id,d.track_focus(&focus).child(ui::guide_focus_ring(focus,self.keyboard.clone(),1.)).on_click(cx.listener(move|s,_,w,cx|{
            s.keyboard.set(false);if enabled{s.activate(&click_id,w,cx);}cx.stop_propagation();
        })))
    }
    /// Test hook: the id of the footer/row control that holds focus, for naming an unnamed Tab stop.
    #[cfg(feature="ui-tests")]
    pub fn focused_control_name(&self,w:&Window)->Option<String>{self.focus_controls.borrow().iter().find(|(_,f)|f.is_focused(w)).map(|(id,_)|id.clone())}
    fn scroll_row(&self,id:u64,strip:bool){
        if let Some(index)=self.rows.iter().position(|r|r.id==id){
            let before=self.strip.as_ref().and_then(|s|self.rows.iter().position(|r|r.id==s.id)).is_some_and(|i|i<index);
            self.scroll.scroll_to_item(index+usize::from(before)+usize::from(strip));
        }
    }
    fn focus_at(&self,id:&str,w:&mut Window,cx:&mut Context<Self>){
        if let Some(number)=id.strip_prefix("input-").and_then(|s|s.parse::<u64>().ok()) {
            self.scroll_row(number,false);
            if let Some(input)=self.input(number){input.update(cx,|s,cx|s.focus(w,cx));}
        }else if id=="replacement" {self.replacement.update(cx,|s,cx|s.focus(w,cx));}
        else if let Some(focus)=self.focus_controls.borrow().get(id){
            // The source autofocuses this footer button. Reveal it in the help
            // sheet's own scroll container, including after a keyboard wrap.
            if id=="lyed-help-close" {self.help_scroll.scroll_to_bottom();}
            else if let Some(row)=id.strip_prefix("lyed-word-").and_then(|s|s.rsplit_once('-')).and_then(|(r,_)|r.parse().ok()){self.scroll_row(row,true);}
            else if let Some(row)=id.rsplit_once('-').and_then(|(_,r)|r.parse().ok()){self.scroll_row(row,false);}
            focus.focus(w,cx);
        }
    }
    fn focused_item(&self,w:&Window,cx:&App)->Option<String>{
        self.order.borrow().iter().find(|id|{
            if let Some(id)=id.strip_prefix("input-").and_then(|s|s.parse::<u64>().ok()){self.input(id).is_some_and(|s|s.read(cx).focus_handle(cx).is_focused(w))}
            else if id.as_str()=="replacement" {self.replacement.read(cx).focus_handle(cx).is_focused(w)}
            else {self.focus_controls.borrow().get(*id).is_some_and(|f|f.is_focused(w))}
        }).cloned()
    }
    fn move_focus(&mut self,backwards:bool,w:&mut Window,cx:&mut Context<Self>){
            self.keyboard.set(true);let order=self.order.borrow().clone();if !order.is_empty(){
                let current=order.iter().position(|id| {
                    if let Some(id)=id.strip_prefix("input-").and_then(|s|s.parse::<u64>().ok()){self.input(id).is_some_and(|s|s.read(cx).focus_handle(cx).is_focused(w))}
                    else if id=="replacement" {self.replacement.read(cx).focus_handle(cx).is_focused(w)}
                    else {self.focus_controls.borrow().get(id).is_some_and(|f|f.is_focused(w))}
                });
                let next=match current {Some(i) if backwards=>(i+order.len()-1)%order.len(),Some(i)=>(i+1)%order.len(),None=>if backwards{order.len()-1}else{0}};
                self.focus_at(&order[next],w,cx);cx.notify();
            }
    }
    fn key(&mut self,event:&KeyDownEvent,w:&mut Window,cx:&mut Context<Self>){
        let key=event.keystroke.key.as_str();let modifiers=event.keystroke.modifiers;
        let command=if cfg!(target_os="macos"){modifiers.platform}else{modifiers.control};
        if key=="escape" {self.request_close(cx);cx.stop_propagation();return;}
        if key=="tab" {self.move_focus(modifiers.shift,w,cx);cx.stop_propagation();return;}
        if self.help {if key=="enter"||key=="space"{self.help=false;cx.notify();}cx.stop_propagation();return;}
        if command&&key=="z" {
            let rows=if modifiers.shift{self.history.redo(&self.rows)}else{self.history.undo(&self.rows)};
            if let Some(rows)=rows{self.rows=rows;self.dirty=true;self.revision+=1;self.text_group=None;cx.notify();}cx.stop_propagation();return;
        }
        let focused=self.inputs.iter().find(|(_,r)|r.input.read(cx).focus_handle(cx).is_focused(w)).map(|(id,r)|(*id,r.input.clone()));
        if let Some((id,input))=focused {
            if command&&key=="v" {if let Some(text)=cx.read_from_clipboard().and_then(|c|c.text()){if text.contains('\n') {self.apply(edit::insert_pasted(&self.rows,id,&text),cx);cx.stop_propagation();return;}}}
            let caret=input.read(cx).cursor();let text=input.read(cx).value();
            let index=self.rows.iter().position(|r|r.id==id).unwrap_or(0);
            if command&&key=="enter" {self.apply(edit::stamp_row(&self.rows,id,self.position),cx);}
            else if command&&key=="backspace" {self.apply(edit::delete_row(&self.rows,id),cx);}
            else if command&&key=="e" {self.toggle_strip(id,cx);if self.strip.is_some(){self.pending_control=Some(format!("lyed-word-{id}-0"));}}
            else if key=="enter"&&!command {self.apply(edit::split_row(&self.rows,id,edit::utf16_at_byte(&text,caret)),cx);}
            else if key=="backspace"&&!command&&input.read(cx).selected_range()==(0..0)&&index>0 {self.apply(edit::merge_up(&self.rows,id),cx);}
            else if key=="up"&&index>0 {self.pending_focus=Some(edit::FocusTarget{id:self.rows[index-1].id,caret_utf16:None});cx.notify();}
            else if key=="down"&&index+1<self.rows.len(){self.pending_focus=Some(edit::FocusTarget{id:self.rows[index+1].id,caret_utf16:None});cx.notify();}
            else{return;}
            cx.stop_propagation();return;
        }
        let focused=self.focus_controls.borrow().iter().find(|(_,f)|f.is_focused(w)).map(|(id,_)|id.clone());
        if let Some(id)=focused {
            if let Some(rest)=id.strip_prefix("lyed-word-") {
                if let Some((row,index))=rest.rsplit_once('-').and_then(|(r,i)|Some((r.parse::<u64>().ok()?,i.parse::<usize>().ok()?))) {
                    if (key=="left"||key=="right")&&self.strip.as_ref().is_some_and(|s|s.id==row){
                        let words=self.words(row);if let Some(word)=words.get(index){let win=self.strip.as_ref().unwrap();
                            let next=edit::move_word_start(&words,index,word.s+if key=="left"{-0.05}else{0.05},win.lo,win.hi);self.change_words(row,next,cx);}
                        cx.stop_propagation();return;
                    }
                }
            }
            if key=="enter"||key=="space" {self.activate(&id,w,cx);cx.stop_propagation();}
        }
    }
    fn drag_move(&mut self,position:Point<Pixels>,cx:&mut Context<Self>){
        let (Some(mut drag),Some(win))=(self.drag,self.strip.as_ref())else{return;};
        if let Some(bounds)=self.bounds(&format!("lyed-strip-{}",drag.row)) {
            drag.time=win.t0+f64::from(f32::from(position.x-bounds.left())/f32::from(bounds.size.width).max(1.))*(win.t1-win.t0)-drag.grab;
            self.drag=Some(drag);cx.notify();
        }
    }
    fn drag_end(&mut self,position:Point<Pixels>,cx:&mut Context<Self>){
        self.drag_move(position,cx);let Some(drag)=self.drag.take()else{return;};
        if let Some(win)=self.strip.as_ref(){if let Some(words)=edit::commit_word_drag(&self.words(drag.row),drag.index,drag.time,win.lo,win.hi){self.change_words(drag.row,words,cx);}}
        cx.notify();
    }
    fn word_strip(&self,win:StripWindow,w:&Window,cx:&mut Context<Self>)->Stateful<Div>{
        let span=(win.t1-win.t0).max(0.001);let words=self.words(win.id);
        let shown=self.drag.filter(|d|d.row==win.id).map_or_else(||words.clone(),|d|edit::move_word_start(&words,d.index,d.time,win.lo,win.hi));
        let fine=self.fine.clone();let bounds=self.bounds.clone();let key=format!("lyed-strip-{}",win.id);let ghost_key=key.clone();let weak=cx.weak_entity();
        ui::lyrics_editor_word_strip().id(key.clone())
            .on_mouse_down(MouseButton::Left,cx.listener(move|_,e:&MouseDownEvent,_,cx|{
                if let Some(b)=bounds.borrow().get(&ghost_key){let t=win.t0+f64::from(f32::from(e.position.x-b.left())/f32::from(b.size.width).max(1.))*span;cx.emit(Event::Seek{position:t.max(0.),play:false});}cx.stop_propagation();
            }))
            .child(canvas(move|b,_,_|b,move|_,b,w,cx|{
                if let Some(fine)=&fine {let width=f32::from(b.size.width);for x in 0..width.ceil() as usize {
                    let a=win.t0+span*x as f64/width.max(1.) as f64;let z=win.t0+span*(x+1) as f64/width.max(1.) as f64;
                    let h=(edit::span_level(fine,a,z).min(1.) as f32*(f32::from(b.size.height)-8.)).max(1.);
                    w.paint_quad(fill(Bounds::new(point(b.left()+px(x as f32),b.center().y-px(h/2.)),size(px(1.),px(h))),ui::canvas_color(rgb(ACCENT).alpha(0.6).into())));
                }}
                let moving=weak.clone();w.on_mouse_event(move|e:&MouseMoveEvent,phase,_,cx|{if phase==DispatchPhase::Capture{let _=moving.update(cx,|s,cx|if s.drag.is_some(){s.drag_move(e.position,cx);cx.stop_propagation();});}});
                let ending=weak.clone();w.on_mouse_event(move|e:&MouseUpEvent,phase,_,cx|{if phase==DispatchPhase::Capture&&e.button==MouseButton::Left{let _=ending.update(cx,|s,cx|if s.drag.is_some(){s.drag_end(e.position,cx);cx.stop_propagation();});}});
            }).absolute().inset_0())
            .child(self.playhead.clone())
            .children(shown.iter().enumerate().map(|(i,word)|{
                let id=format!("lyed-word-{}-{i}",win.id);let focused=self.focus_controls.borrow().get(&id).is_some_and(|f|f.is_focused(w));
                let focus=self.focus_controls.borrow_mut().entry(id.clone()).or_insert_with(||cx.focus_handle()).clone();
                self.order.borrow_mut().push(id.clone());
                let width=((word.e-word.s)/span).max(0.012) as f32;let row=win.id;let initial=words[i].s;
                let label=w.text_system().shape_line(word.w.clone().into(),px(11.),&[TextRun{len:word.w.len(),font:Font{family:DISPLAY_600.into(),..Default::default()},color:rgb(TEXT).into(),background_color:None,underline:None,strikethrough:None}],None);
                self.probe_positioned(&id,ui::lyrics_editor_word(id.clone(),word.w.clone(),i%2==1,self.drag.is_some_and(|d|d.index==i),focused)
                    .track_focus(&focus).left(relative(((word.s-win.t0)/span) as f32)).w(relative(width)).min_w(label.width+px(10.))
                    .on_mouse_down(MouseButton::Left,cx.listener(move|s,e:&MouseDownEvent,w,cx|{
                        focus.focus(w,cx);if e.click_count==2 {let words=edit::move_word_start(&s.words(row),i,s.position,win.lo,win.hi);s.change_words(row,words,cx);s.drag=None;}
                        else if let Some(b)=s.bounds(&format!("lyed-strip-{row}")) {let time=win.t0+f64::from(f32::from(e.position.x-b.left())/f32::from(b.size.width).max(1.))*span;
                            s.drag=Some(Drag{row,index:i,time:initial,grab:time-initial});}
                        cx.stop_propagation();cx.notify();
                    })))
            }))
            .child({let b=self.bounds.clone();canvas(move|bounds,_,_|{b.borrow_mut().insert(key.clone(),bounds);bounds},|_,_,_,_|{}).absolute().inset_0()})
    }
}
impl Render for Editor {
    fn render(&mut self,w:&mut Window,cx:&mut Context<Self>)->impl IntoElement {
        self.ensure_inputs(w,cx);self.order.borrow_mut().clear();
        let strip=if self.help||self.replace||self.discard {None}else{self.strip};
        self.playhead.update(cx,|s,cx|if s.strip!=strip{s.strip=strip;cx.notify();});
        let blocked=self.busy||self.saving;let current=edit::active_row(&self.rows,self.position);
        let silent=edit::silent_row_ids(&self.rows,self.coarse.as_deref());
        let button=|s:&Self,id:&str,label:String,enabled:bool,primary:bool,cx:&mut Context<Self>|s.button(id.into(),ui::lyrics_editor_button(id.to_owned(),label,primary,enabled),enabled,true,cx);
        let mut card=ui::lyrics_editor_card(w.viewport_size()).id("lyrics-editor-card").key_context("SingZLyricsEditor").track_focus(&self.scope)
            .on_action(cx.listener(|s,_:&NextFocus,w,cx|{s.move_focus(false,w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|s,_:&PreviousFocus,w,cx|{s.move_focus(true,w,cx);cx.stop_propagation();}))
            // Textarea's own Input context otherwise consumes Tab as indent
            // before the editor's raw keyboard listener can trap focus.
            .capture_action(cx.listener(|s,_:&gpui_kit::component::input::IndentInline,w,cx|{s.move_focus(false,w,cx);cx.stop_propagation();}))
            .capture_action(cx.listener(|s,_:&gpui_kit::component::input::OutdentInline,w,cx|{s.move_focus(true,w,cx);cx.stop_propagation();}))
            .on_mouse_down(MouseButton::Left,|_,_,cx|cx.stop_propagation())
            .capture_key_down(cx.listener(|s,e,w,cx|s.key(e,w,cx)))
            .child(ui::lyrics_editor_head()
                .child(div().flex().items_baseline().gap(px(12.)).flex_1().min_w_0()
                    .child(ui::lyrics_editor_title(copy("title"))).when(self.dirty,|d|d.child(ui::lyrics_editor_dirty_dot())).child(ui::lyrics_editor_song(self.name.clone())))
                .child(div().flex().items_center().gap(px(10.))
                    .child(self.button("lyed-play".into(),ui::lyrics_editor_play("lyed-play",self.playing),true,true,cx))
                    .child(ui::lyrics_editor_clock(edit::fmt_stamp(Some(self.position))))
                    .child(self.button("lyed-help".into(),ui::lyrics_editor_help_button("lyed-help",false),true,true,cx))))
            .child(ui::lyrics_editor_tools()
                .child(self.button("lyed-align".into(),ui::lyrics_editor_tool("lyed-align",copy("tools.alignLabel"),!blocked,false),!blocked,true,cx))
                .when(self.precise,|d|d.child(self.button("lyed-precise".into(),ui::lyrics_editor_tool("lyed-precise",copy("tools.preciseLabel"),!blocked,false),!blocked,true,cx)))
                .child(self.button("lyed-replace".into(),ui::lyrics_editor_tool("lyed-replace",copy("replaceAll"),!blocked,false),!blocked,true,cx))
                .when(!silent.is_empty(),|d|d.child(self.button("lyed-drop-silent".into(),ui::lyrics_editor_tool("lyed-drop-silent",crate::i18n::tn("lyrics.editor.tools.silentLines",silent.len() as f64,&[]),!blocked,true),!blocked,true,cx)))
                .child(div().flex_1())
                .child(self.button("lyed-undo".into(),ui::lyrics_editor_linkish("lyed-undo",copy("undo"),self.history.can_undo()),self.history.can_undo(),true,cx)));
        if let Some(notice)=&self.notice {card=card.child(ui::lyrics_editor_status(notice.clone(),true));}
        if self.replace {
            self.order.borrow_mut().push("replacement".into());
            card=card.child(div().flex().flex_col().flex_1().min_h_0().gap(px(8.))
                .child(ui::lyrics_editor_replacement_input(&self.replacement,self.replacement.read(cx).focus_handle(cx).is_focused(w)).flex_1())
                .child(div().flex().justify_end().gap(px(8.)).child(button(self,"lyed-replace-cancel",copy("cancel"),true,false,cx)).child(button(self,"lyed-replace-apply",copy("replace.use"),true,true,cx))));
        } else {
            let rows=self.rows.clone();let mut list=ui::lyrics_editor_list("lyed-list").track_scroll(&self.scroll);
            for (i,row) in rows.iter().enumerate(){
                let id=row.id;let input=self.input(id).unwrap();let focused=input.read(cx).focus_handle(cx).is_focused(w);
                let mut print=ui::lyrics_editor_print_button(format!("lyed-print-{id}"),self.strip.as_ref().is_some_and(|s|s.id==id),false,row.start.is_some());
                if let (Some(env),Some(start))=(&self.coarse,row.start){let end=row.end.unwrap_or_else(||edit::estimate_line_end(&row.text,start));
                    print=print.child(ui::lyrics_editor_voiceprint(std::array::from_fn(|i|edit::span_level(env,start+(end-start)*i as f64/18.,start+(end-start)*(i+1) as f64/18.).min(1.) as f32)));}
                let stamp=format!("lyed-stamp-{id}");let print_id=format!("lyed-print-{id}");let add=format!("lyed-add-{id}");let remove=format!("lyed-remove-{id}");

                let group:SharedString=format!("lyed-row-{id}").into();
                let add_focused=self.focus_controls.borrow().get(&add).is_some_and(|f|f.is_focused(w));
                let remove_focused=self.focus_controls.borrow().get(&remove).is_some_and(|f|f.is_focused(w));
                let line=ui::lyrics_editor_row(format!("lyed-row-{id}"),current==Some(i)).group(group.clone())
                    .child(self.button(stamp.clone(),ui::lyrics_editor_stamp(stamp,edit::fmt_stamp(row.start),false,true),true,true,cx))
                    .child(self.button(print_id,print,row.start.is_some(),false,cx))
                    .child(ui::lyrics_editor_row_input(&input,focused,silent.contains(&id)).accessibility_id(format!("lyed-input-{id}")).aria_label(copy("row.placeholder")))
                    .child(self.button(add.clone(),ui::lyrics_editor_row_action(add,false,false,add_focused,true).group_hover(group.clone(),|s|s.opacity(1.)),true,false,cx))
                    .child(self.button(remove.clone(),ui::lyrics_editor_row_action(remove,true,false,remove_focused,true).group_hover(group.clone(),|s|s.opacity(1.)),true,false,cx));
                self.order.borrow_mut().push(format!("input-{id}"));list=list.child(self.probe(&format!("lyed-row-{id}"),line));
                if let Some(win)=self.strip.as_ref().filter(|s|s.id==id){list=list.child(self.word_strip(*win,w,cx));}
            }
            card=card.child(self.probe("lyed-list",list.child(ui::production_scrollbar(&self.scroll))));
        }
        let status=if let Some(error)=&self.error{ui::lyrics_editor_status(error.clone(),true)}
            else if let Some(check)=&self.check{let description=edit::describe_check_in(check,self.precise,crate::i18n::current());ui::lyrics_editor_status(description.text,description.warn)}
            else {let untimed=self.rows.iter().filter(|r|r.start.is_none()&&!edit::trim_text(&r.text).is_empty()).count();
                let base=copy("hint.base").replace("{mod}",if cfg!(target_os="macos"){ "⌘Enter" }else{"Ctrl+Enter"});
                let suffix=if untimed>0{crate::i18n::tn("lyrics.editor.hint.untimed",untimed as f64,&[])}else{copy("hint.voiceprint")};
                ui::lyrics_editor_status(format!("{base}{suffix}"),false)};
        let mut footer=ui::lyrics_editor_footer();
        if self.busy {
            let (label,p)=self.progress.clone().unwrap_or((copy("stage.preparing"),0.));
            footer=footer.child(div().flex().items_center().gap(px(6.)).min_w_0().child(ui::lyrics_editor_status(format!("{label}… {}%",p.round()),false)).child(ui::lyrics_editor_busy_bar(p/100.)).child(button(self,"lyed-align-cancel",copy("cancel"),true,false,cx)));
        } else if let Some((_,mb,aligner))=self.consent {
            footer=footer.child(div().flex().min_w_0().items_center().gap(px(6.)).child(ui::lyrics_editor_status(copy(if aligner{"consent.aligner"}else{"consent.speech"}).replace("{mb}",&mb.to_string()),false)).child(button(self,"lyed-align-download",copy("consent.download"),true,true,cx)).child(button(self,"lyed-align-not-now",copy("consent.notNow"),true,false,cx)));
        } else {footer=footer.child(status.min_w_0());}
        footer=footer.child(div().flex_1());
        if self.discard {
            footer=footer.child(ui::lyrics_editor_status(copy("discard.question"),false)).child(button(self,"lyed-keep",copy("discard.keep"),true,false,cx)).child(button(self,"lyed-discard",copy("discard.discard"),true,false,cx));
        } else {
            footer=footer.child(button(self,"lyed-cancel",copy("cancel"),!self.busy&&!self.saving,false,cx)).child(button(self,"lyed-save",copy(if self.saving{"save.saving"}else{"save.label"}),!blocked&&self.rows.iter().any(|r|!edit::trim_text(&r.text).is_empty()),true,cx));
        }
        card=card.child(footer);
        if self.help {
            self.order.borrow_mut().clear();
            let modifier=if cfg!(target_os="macos"){ "⌘" }else{ "Ctrl" };
            let sections=vec![
                ("help.sectionLines",vec![(vec!["Enter"],None,"help.lineNew"),(vec![],Some("+".into()),"help.lineAdd"),(vec!["Backspace"],None,"help.lineMerge"),(vec![modifier,"Backspace"],None,"help.lineRemove"),(vec!["↑","↓"],None,"help.lineMove"),(vec![],Some(copy("help.labelPaste")),"help.linePaste")]),
                ("help.sectionTiming",vec![(vec![modifier,"Enter"],None,"help.timingStamp"),(vec![],Some(copy("help.labelTimeChip")),"help.timingChip"),(vec![],Some(copy("help.labelAlign")),"help.timingAlign")]),
                ("help.sectionWords",vec![(vec![],Some(copy("help.labelVoiceprint")),"help.wordsVoiceprint"),(vec![],Some(copy("help.labelDrag")),"help.wordsDrag"),(vec![],Some(copy("help.labelDoubleClick")),"help.wordsDoubleClick"),(vec!["←","→"],None,"help.wordsNudge")]),
                ("help.sectionOther",vec![(vec![modifier,"Z"],None,"help.otherUndo"),(vec![],Some(copy("replaceAll")),"help.otherReplace"),(vec!["Esc"],None,"help.otherClose")]),
            ];
            let card_size=self.bounds("lyrics-editor-card").map_or(w.viewport_size(),|b|b.size);
            let help=ui::lyrics_editor_help_card("lyed-help-card",card_size)
                .track_scroll(&self.help_scroll)
                .on_mouse_down(MouseButton::Left,|_,_,cx|cx.stop_propagation())
                .child(ui::lyrics_editor_help_heading(copy("helpTitle")))
                .child(ui::lyrics_editor_help_columns().children(sections.into_iter().map(|(title,rows)|div().min_w_0().child(ui::lyrics_editor_help_section(copy(title))).children(rows.into_iter().map(|(keys,label,description)|{
                    let keys=if let Some(label)=label{div().child(ui::lyrics_editor_help_key(label,true))}else{div().children(keys.into_iter().map(|key|ui::lyrics_editor_help_key(key,false)))};
                    ui::lyrics_editor_help_row(keys,copy(description).replace("{mod}",modifier))
                })))))
                .child(div().flex().justify_end().mt(px(16.)).child(button(self,"lyed-help-close",copy("help.gotIt"),true,true,cx)));
            card=card.child(ui::lyrics_editor_help_sheet().on_mouse_down(MouseButton::Left,cx.listener(|s,_,_,cx|{s.help=false;cx.stop_propagation();cx.notify();})).child(help));
        }
        if let Some(id)=self.pending_control.take(){self.focus_at(&id,w,cx);}
        self.probe("lyrics-editor-card",card)
    }
}

#[cfg(test)]
mod display_clock_tests {
    use super::DisplayClock;
    use std::time::{Duration, Instant};
    fn clock(now:Instant)->DisplayClock {
        DisplayClock{position:4.,duration:30.,playing:true,anchor:Some((4.,now)),rate:1.,loop_range:None}
    }
    #[test]
    fn cursor_advances_fractionally_at_display_cadence_and_caps_stale_native_sample() {
        let now=Instant::now();let c=clock(now);
        assert!((c.position_at(now+Duration::from_millis(16))-4.016).abs()<1e-9);
        assert!((c.position_at(now+Duration::from_millis(33))-4.033).abs()<1e-9);
        assert!((c.position_at(now+Duration::from_secs(2))-4.1).abs()<1e-9);
        assert!(!c.advancing(now+Duration::from_millis(100)));
    }
    #[test]
    fn pause_seek_and_missing_authority_never_extrapolate_old_anchor() {
        let now=Instant::now();let mut c=clock(now);
        c.playing=false;c.position=12.;
        assert_eq!(c.position_at(now+Duration::from_secs(5)),12.);
        assert!(!c.advancing(now));
        c.playing=true;c.anchor=None;c.position=21.;
        assert_eq!(c.position_at(now+Duration::from_secs(5)),21.);
        assert!(!c.advancing(now));
        c.anchor=Some((21.,now+Duration::from_secs(5)));
        assert!((c.position_at(now+Duration::from_millis(5016))-21.016).abs()<1e-9);
    }
    #[test]
    fn native_rate_loop_and_end_follow_same_bounded_clock() {
        let now=Instant::now();let mut c=clock(now);
        c.anchor=Some((9.98,now));c.rate=2.;c.loop_range=Some((5.,10.));
        assert!((c.position_at(now+Duration::from_millis(20))-5.02).abs()<1e-9);
        c.loop_range=None;c.duration=10.;
        assert_eq!(c.position_at(now+Duration::from_millis(20)),10.);
        assert!(!c.advancing(now+Duration::from_millis(20)));
    }
}
