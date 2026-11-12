//! Nonmodal source LanguageSwitcher menu. Locale IO and header trigger stay host-owned.
use crate::i18n::{self, Language, Locale};
use gpui_kit::{prelude::FluentBuilder, *};
use singz_uikit as ui;
use std::{cell::{Cell,RefCell},collections::HashMap,rc::Rc,time::Instant};
actions!(singz_language_menu,[Next,Previous,First,Last,Activate,Dismiss,LeaveNext,LeavePrevious]);

#[derive(Clone,Debug)]
pub enum Event { Pick(Language), Dismiss }
#[derive(Clone)]
struct Row { value:Language,label:String,hint:Option<String> }
pub struct LanguageMenu {
    open:bool,
    language:Language,
    locale:Locale,
    system_locale:Locale,
    trigger:Bounds<Pixels>,
    trigger_focus:Option<FocusHandle>,
    scope:FocusHandle,
    controls:Vec<FocusHandle>,
    scroll:ScrollHandle,
    bounds:Rc<RefCell<HashMap<String,Bounds<Pixels>>>>,
    keyboard:Rc<Cell<bool>>,
    pending_focus:bool,
    opened_at:Instant,
    animation_time:Option<f32>,
    frame_pending:bool,
}
impl EventEmitter<Event> for LanguageMenu {}
impl LanguageMenu {
    pub fn new(_window:&mut Window,cx:&mut Context<Self>)->Self {
        cx.bind_keys([
            KeyBinding::new("down",Next,Some("SingZLanguageMenu")),
            KeyBinding::new("up",Previous,Some("SingZLanguageMenu")),
            KeyBinding::new("home",First,Some("SingZLanguageMenu")),
            KeyBinding::new("end",Last,Some("SingZLanguageMenu")),
            KeyBinding::new("enter",Activate,Some("SingZLanguageMenu")),
            KeyBinding::new("space",Activate,Some("SingZLanguageMenu")),
            KeyBinding::new("escape",Dismiss,Some("SingZLanguageMenu")),
            KeyBinding::new("tab",LeaveNext,Some("SingZLanguageMenu")),
            KeyBinding::new("shift-tab",LeavePrevious,Some("SingZLanguageMenu")),
        ]);
        Self {open:false,language:Language::System,locale:Locale::En,system_locale:Locale::En,
            trigger:Bounds::default(),trigger_focus:None,scope:cx.focus_handle(),
            // Arrow navigation owns these rows. Leaving with Tab uses only
            // host tab stops, never the disappearing menu's previous layout.
            controls:Language::ALL.iter().map(|_|cx.focus_handle()).collect(),
            scroll:ScrollHandle::new(),bounds:Default::default(),keyboard:Rc::new(Cell::new(false)),
            pending_focus:false,opened_at:Instant::now(),animation_time:None,frame_pending:false}
    }
    pub fn open(&mut self,language:Language,locale:Locale,system_locale:Locale,
        trigger:Bounds<Pixels>,trigger_focus:Option<FocusHandle>,window:&mut Window,cx:&mut Context<Self>) {
        self.open=true;self.language=language;self.locale=locale;self.system_locale=system_locale;
        self.trigger=trigger;self.trigger_focus=trigger_focus;self.pending_focus=true;
        self.keyboard.set(window.last_input_was_keyboard());self.opened_at=Instant::now();self.scroll.set_offset(point(px(0.),px(0.)));
        self.scope.focus(window,cx);cx.notify();
    }
    /// Host applies the shared i18n locale atomically before calling this.
    pub fn set_locale(&mut self,language:Language,locale:Locale,system_locale:Locale,cx:&mut Context<Self>) {
        if (self.language,self.locale,self.system_locale)!=(language,locale,system_locale) {
            self.pending_focus|=self.open&&self.language!=language;
            self.language=language;self.locale=locale;self.system_locale=system_locale;cx.notify();
        }
    }
    pub fn set_anchor(&mut self,trigger:Bounds<Pixels>,cx:&mut Context<Self>) {
        if self.trigger!=trigger {self.trigger=trigger;cx.notify();}
    }
    pub fn is_open(&self)->bool {self.open}
    pub fn close(&mut self,window:&mut Window,cx:&mut Context<Self>) {
        if !self.open {return;}
        let owned=self.scope.contains_focused(window,cx)||self.controls.iter().any(|f|f.is_focused(window));
        self.open=false;self.pending_focus=false;self.bounds.borrow_mut().clear();
        if owned {if let Some(trigger)=&self.trigger_focus {trigger.focus(window,cx);}}
        cx.notify();
    }
    pub fn set_animation_time(&mut self,time:Option<f32>,cx:&mut Context<Self>) {
        self.animation_time=time.map(|time|time.max(0.));cx.notify();
    }
    /// The clipped scroll viewport; a row is visible only when inside it.
    pub fn scroll_viewport(&self)->Bounds<Pixels> {self.scroll.bounds()}
    pub fn bounds(&self,id:&str)->Option<Bounds<Pixels>> {self.bounds.borrow().get(id).copied()}
    fn rows(&self)->Vec<Row> {
        let os=if cfg!(target_os="windows") {"Windows"}else if cfg!(target_os="macos") {"macOS"}else{"Linux"};
        std::iter::once(Row {value:Language::System,label:i18n::t("lang.system"),
            hint:Some(i18n::tv("lang.systemHint",&[("os",os.into()),("name",self.system_locale.endonym().into())]))})
            .chain(Locale::ALL.into_iter().map(|locale| {
                let label=locale.endonym().to_owned();let named=i18n::t(&format!("lang.{}",locale.as_str()));
                Row {value:Language::Locale(locale),hint:(named!=label).then_some(named),label}
            })).collect()
    }
    fn selected(&self)->usize {Language::ALL.iter().position(|value|*value==self.language).unwrap_or(0)}
    fn focused(&self,window:&Window)->Option<usize> {self.controls.iter().position(|f|f.is_focused(window))}
    fn focus(&self,index:usize,window:&mut Window,cx:&mut Context<Self>) {
        self.scroll.scroll_to_item(index);self.controls[index].focus(window,cx);
    }
    fn navigate(&mut self,index:usize,window:&mut Window,cx:&mut Context<Self>) {
        self.keyboard.set(true);self.focus(index,window,cx);cx.notify();
    }
    fn dismiss(&mut self,window:&mut Window,cx:&mut Context<Self>) {
        if self.open {self.close(window,cx);cx.emit(Event::Dismiss);}
    }
    fn pick(&mut self,index:usize,window:&mut Window,cx:&mut Context<Self>) {
        let value=Language::ALL[index];let changed=value!=self.language;
        self.close(window,cx);
        if changed {cx.emit(Event::Pick(value));}else{cx.emit(Event::Dismiss);}
    }
    fn leave(&mut self,backwards:bool,window:&mut Window,cx:&mut Context<Self>) {
        self.dismiss(window,cx);
        if backwards {window.focus_prev(cx);}else{window.focus_next(cx);}
    }
    fn probe(&self,id:String,d:Stateful<Div>)->Stateful<Div> {
        let bounds=self.bounds.clone();
        d.relative().child(canvas(move |b,_,_| {
            // Absolute inset0 lays this canvas inside the parent's border.
            // The popup surface has exactly a1px border; report its complete
            // border box without moving either the surface or the paint probe.
            let measured=if id=="language-menu" {b.dilate(px(1.))}else{b};
            bounds.borrow_mut().insert(id.clone(),measured);b
        },|_,_,_,_|{}).absolute().inset_0())
    }
    pub fn state(&self,window:&Window,cx:&App)->serde_json::Value {
        serde_json::json!({"open":self.open,"language":self.language,"locale":self.locale,"systemLocale":self.system_locale,
            "rows":self.rows().into_iter().map(|r|serde_json::json!({"value":r.value,"label":r.label,"hint":r.hint,"selected":r.value==self.language})).collect::<Vec<_>>(),
            "selectedIndex":self.selected(),"focusedIndex":self.focused(window),
            "focusedControl":self.focused(window).map(|i|format!("language-option-{}",Language::ALL[i].as_str())),
            "focusInside":self.scope.contains_focused(window,cx),"scrollOffset":[f32::from(self.scroll.offset().x),f32::from(self.scroll.offset().y)],
            "maxScrollOffset":[f32::from(self.scroll.max_offset().x),f32::from(self.scroll.max_offset().y)],
            "trigger":[f32::from(self.trigger.left()),f32::from(self.trigger.top()),f32::from(self.trigger.size.width),f32::from(self.trigger.size.height)],
            "animationSeconds":self.animation_time.unwrap_or_else(||self.opened_at.elapsed().as_secs_f32())})
    }
}
impl Render for LanguageMenu {
    fn render(&mut self,window:&mut Window,cx:&mut Context<Self>)->impl IntoElement {
        self.bounds.borrow_mut().clear();
        if !self.open {return div().into_any_element();}
        let rows=self.rows();let viewport=window.viewport_size();
        let width=ui::language_menu_width(&rows.iter().map(|r|(r.label.clone(),r.hint.clone())).collect::<Vec<_>>(),window)
            .min((f32::from(viewport.width)-24.).max(0.));
        let left=(f32::from(self.trigger.right())-width).max(12.).min((f32::from(viewport.width)-width-12.).max(0.));
        let top=f32::from(self.trigger.bottom())+6.;
        let natural=ui::language_menu_natural_height(rows.iter().map(|r|r.hint.is_some()));
        // Source's header popup has no viewport cap. Bound its overflow in the
        // smaller native viewport so all14real choices remain reachable.
        let height=natural.min((f32::from(viewport.height)-top-12.).max(0.));
        let mut list=ui::language_menu_rows(&self.scroll);
        for (index,row) in rows.iter().enumerate() {
            let id=format!("language-option-{}",row.value.as_str());let focus=self.controls[index].clone();
            let mouse_focus=focus.clone();
            let tag=match row.value {Language::System=>None,Language::Locale(locale)=>Some(locale.as_str())};
            let d=ui::language_menu_row(id.clone(),tag,row.label.clone(),row.hint.clone(),row.value==self.language,
                self.keyboard.get()&&focus.is_focused(window),window)
                .track_focus(&focus)
                .role(gpui_kit::accesskit::Role::MenuItemRadio).accessibility_id(id.clone()).aria_label(row.label.clone());
            let d=crate::a11y::chosen(d,row.value==self.language)
                .on_mouse_down(MouseButton::Left,cx.listener(move |s,_,w,cx| {s.keyboard.set(false);mouse_focus.focus(w,cx);cx.stop_propagation();}))
                .on_click(cx.listener(move |s,_,w,cx| {s.pick(index,w,cx);cx.stop_propagation();}));
            list=list.child(self.probe(id,d));
        }
        let mut menu=ui::language_menu_surface(width,height).key_context("SingZLanguageMenu").track_focus(&self.scope)
            .role(gpui_kit::accesskit::Role::Menu).accessibility_id("language-menu").aria_label(crate::i18n::t("lang.label"))
            .on_action(cx.listener(|s,_:&Next,w,cx|{s.navigate((s.focused(w).unwrap_or(s.selected())+1)%Language::ALL.len(),w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|s,_:&Previous,w,cx|{s.navigate((s.focused(w).unwrap_or(s.selected())+Language::ALL.len()-1)%Language::ALL.len(),w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|s,_:&First,w,cx|{s.navigate(0,w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|s,_:&Last,w,cx|{s.navigate(Language::ALL.len()-1,w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|s,_:&Activate,w,cx|{if let Some(index)=s.focused(w){s.pick(index,w,cx);}cx.stop_propagation();}))
            .on_action(cx.listener(|s,_:&Dismiss,w,cx|{s.dismiss(w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|s,_:&LeaveNext,w,cx|{s.leave(false,w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|s,_:&LeavePrevious,w,cx|{s.leave(true,w,cx);cx.stop_propagation();}))
            .on_mouse_down_out(cx.listener(|s,event:&MouseDownEvent,w,cx| {
                if !s.trigger.contains(&event.position) {s.dismiss(w,cx);}
            }))
            .on_mouse_down(MouseButton::Left,|_,_,cx|cx.stop_propagation())
            .on_click(|_,_,cx|cx.stop_propagation())
            .child(self.probe("language-rows".into(),list));
        if natural>height {menu=menu.child(ui::production_scrollbar(&self.scroll));}
        if self.pending_focus {self.pending_focus=false;self.focus(self.selected(),window,cx);}
        let elapsed=self.animation_time.unwrap_or_else(||self.opened_at.elapsed().as_secs_f32());
        if self.animation_time.is_none()&&elapsed<0.18&&!self.frame_pending {
            self.frame_pending=true;let weak=cx.weak_entity();
            window.on_next_frame(move |_,cx|{let _=weak.update(cx,|s,cx|{s.frame_pending=false;cx.notify();});});
            window.request_animation_frame();
        }
        // The transparent parent has no dismissal/occlusion handlers: outside
        // presses reach their real underlying controls after source dismissal.
        div().absolute().inset_0().child(div().absolute().left(px(left)).top(px(top))
            .child(ui::language_menu_entrance(self.probe("language-menu".into(),menu),elapsed/0.18)))
            .into_any_element()
    }
}
