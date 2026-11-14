//! Background native AX coverage of real shared UIKit controls, not whole-app certification.
use super::*;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, ffi::{CStr, CString, c_char, c_void}, path::{Path, PathBuf}, time::Duration};
use super::ui_training_run::draw;

const TITLE: &str = "SingZ UIKit accessibility test";
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
type Obj = *mut c_void;
#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> Obj;
    fn sel_registerName(name: *const c_char) -> Obj;
    fn objc_msgSend();
}
unsafe fn selector(name: &str) -> Obj {
    let name = CString::new(name).unwrap();
    unsafe { sel_registerName(name.as_ptr()) }
}
unsafe fn object(receiver: Obj, method: &str) -> Obj {
    let call: unsafe extern "C" fn(Obj, Obj) -> Obj = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { call(receiver, selector(method)) }
}
unsafe fn count(receiver: Obj) -> usize {
    let call: unsafe extern "C" fn(Obj, Obj) -> usize = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { call(receiver, selector("count")) }
}
unsafe fn at(receiver: Obj, index: usize) -> Obj {
    let call: unsafe extern "C" fn(Obj, Obj, usize) -> Obj = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { call(receiver, selector("objectAtIndex:"), index) }
}
unsafe fn responds(receiver: Obj, method: &str) -> bool {
    let call: unsafe extern "C" fn(Obj, Obj, Obj) -> bool = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    !receiver.is_null() && unsafe { call(receiver, selector("respondsToSelector:"), selector(method)) }
}
unsafe fn text(receiver: Obj) -> Option<String> {
    if receiver.is_null() || !unsafe { responds(receiver, "UTF8String") } { return None; }
    let bytes = unsafe { object(receiver, "UTF8String") } as *const c_char;
    (!bytes.is_null()).then(|| unsafe { CStr::from_ptr(bytes) }.to_string_lossy().into_owned())
}
unsafe fn string_property(receiver: Obj, method: &str) -> Option<String> {
    if unsafe { responds(receiver, method) } { unsafe { text(object(receiver, method)) } } else { None }
}
unsafe fn boolean(receiver: Obj, method: &str) -> bool {
    let call: unsafe extern "C" fn(Obj, Obj) -> bool = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { responds(receiver, method) && call(receiver, selector(method)) }
}
unsafe fn number(receiver: Obj) -> Option<f64> {
    if receiver.is_null() { return None; }
    let class=unsafe { objc_getClass(c"NSNumber".as_ptr()) };
    let is_kind: unsafe extern "C" fn(Obj, Obj, Obj) -> bool = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    if class.is_null() || !unsafe { is_kind(receiver,selector("isKindOfClass:"),class) } { return None; }
    let call: unsafe extern "C" fn(Obj, Obj) -> f64 = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    Some(unsafe { call(receiver, selector("doubleValue")) })
}
unsafe fn number_property(receiver: Obj, method: &str) -> Option<f64> {
    if unsafe { responds(receiver, method) } { unsafe { number(object(receiver, method)) } } else { None }
}
unsafe fn value_property(receiver: Obj) -> serde_json::Value {
    if !unsafe { responds(receiver, "accessibilityValue") } { return serde_json::Value::Null; }
    let value=unsafe { object(receiver,"accessibilityValue") };
    if let Some(value)=unsafe { text(value) } { serde_json::json!(value) }
    else { serde_json::json!(unsafe { number(value) }) }
}
/// Queries only this process's NSApplication and its own hidden content view.
/// NSView.accessibilityChildren activates the actual AccessKit macOS adapter;
/// it neither enables VoiceOver nor asks for global accessibility permissions.
unsafe fn native_nodes() -> Vec<(Obj, serde_json::Value)> {
    let class = unsafe { objc_getClass(c"NSApplication".as_ptr()) };
    let app = unsafe { object(class, "sharedApplication") };
    let windows = unsafe { object(app, "windows") };
    let mut root = std::ptr::null_mut();
    for index in 0..unsafe { count(windows) } {
        let window = unsafe { at(windows, index) };
        if unsafe { string_property(window, "title") }.as_deref() == Some(TITLE) {
            root = unsafe { object(window, "contentView") }; break;
        }
    }
    let mut pending = vec![root]; let mut seen = HashSet::new(); let mut result = vec![];
    while let Some(node) = pending.pop() {
        if node.is_null() || !seen.insert(node as usize) || seen.len() > 4096 { continue; }
        if let Some(id) = unsafe { string_property(node, "accessibilityIdentifier") } {
            result.push((node, serde_json::json!({"id":id,
                "role":unsafe { string_property(node,"accessibilityRole") },
                "title":unsafe { string_property(node,"accessibilityTitle") },
                "enabled":unsafe { boolean(node,"isAccessibilityEnabled") },
                "expandedGetterSupported":unsafe { responds(node,"isAccessibilityExpanded") },
                "expanded":if unsafe { responds(node,"isAccessibilityExpanded") } {Some(unsafe { boolean(node,"isAccessibilityExpanded") })}else{None},
                "value":unsafe { value_property(node) },
                "min":unsafe { number_property(node,"accessibilityMinValue") },
                "max":unsafe { number_property(node,"accessibilityMaxValue") }})));
        }
        if unsafe { responds(node, "accessibilityChildren") } {
            let children = unsafe { object(node, "accessibilityChildren") };
            if !children.is_null() { for index in 0..unsafe { count(children) } { pending.push(unsafe { at(children,index) }); } }
        }
    }
    result
}
fn native_action(id: &str, method: &str, value: Option<f64>) -> anyhow::Result<bool> {
    let nodes = unsafe { native_nodes() };
    let (node, _) = nodes.iter().find(|(_, v)| v["id"] == id).ok_or_else(||anyhow::anyhow!("Native AX element missing: {id}"))?;
    if let Some(value) = value {
        let class = unsafe { objc_getClass(c"NSNumber".as_ptr()) };
        let make: unsafe extern "C" fn(Obj, Obj, f64) -> Obj = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        let number = unsafe { make(class, selector("numberWithDouble:"), value) };
        let set: unsafe extern "C" fn(Obj, Obj, Obj) = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        anyhow::ensure!(unsafe { responds(*node, method) }, "Native AX setter missing: {id}");
        unsafe { set(*node, selector(method), number) }; Ok(true)
    } else { Ok(unsafe { boolean(*node, method) }) }
}

struct Controls {
    presses: usize, switch: bool, gain: f32, changed: usize, modal: bool,
    training_gain: f32, training_changed: usize, output_gain: f32, output_changed: usize, checked: bool, second_tab: bool,
    links: usize, select_open: bool, second_input: bool,
    gain_focus: FocusHandle, training_focus: FocusHandle, output_focus: FocusHandle, disabled_focus: FocusHandle,
    background: background::Background,
}
impl Controls {
    fn new(cx: &mut Context<Self>) -> Self { Self { presses:0, switch:false, gain:-18., changed:0, modal:false,
        training_gain:0.5, training_changed:0, output_gain:-6.,output_changed:0, checked:false, second_tab:false, links:0, select_open:false, second_input:false,
        gain_focus:cx.focus_handle(),training_focus:cx.focus_handle(),output_focus:cx.focus_handle(),disabled_focus:cx.focus_handle(),background:background::Background::new() } }
    fn state(&self) -> serde_json::Value { serde_json::json!({"presses":self.presses,"switch":self.switch,"gain":self.gain,"changes":self.changed,"modal":self.modal,
        "trainingGain":self.training_gain,"trainingChanges":self.training_changed,"outputGain":self.output_gain,"outputChanges":self.output_changed,"checked":self.checked,"secondTab":self.second_tab,"links":self.links,"selectOpen":self.select_open,"secondInput":self.second_input}) }
}
impl Render for Controls {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let owner = cx.entity();
        // Keep the production Metal backdrop/grain sized to this same window's
        // actual physical viewport after replacing its ordinary Player root.
        let backdrop=self.background.render(window.viewport_size(),window.scale_factor());
        div().size_full().relative().p(px(24.)).flex().flex_col().gap(px(14.))
            .child(backdrop)
            .child(div().w(px(220.)).child(pill("a11y-press", "Add track", true)
                .on_click(cx.listener(|p,_,_,cx|{p.presses+=1;cx.notify();}))))
            .child(singz_uikit::toggle("a11y-switch",self.switch).aria_label("Monitoring")
                .on_click(cx.listener(|p,_,_,cx|{p.switch=!p.switch;cx.notify();})))
            .child(singz_uikit::checkbox("a11y-check",self.checked).aria_label("Loop practice")
                .on_click(cx.listener(|p,_,_,cx|{p.checked=!p.checked;cx.notify();})))
            .child(div().flex().gap(px(8.)).child(singz_uikit::nav_tab("a11y-tab-first","Audio",!self.second_tab)
                .on_click(cx.listener(|p,_,_,cx|{p.second_tab=false;cx.notify();})))
                .child(singz_uikit::nav_tab("a11y-tab-second","Devices",self.second_tab)
                .on_click(cx.listener(|p,_,_,cx|{p.second_tab=true;cx.notify();}))))
            .child(div().child(singz_uikit::text_link("a11y-link","Help")
                .on_click(cx.listener(|p,_,_,cx|{p.links+=1;cx.notify();}))))
            .child(div().relative().w(px(300.)).child(singz_uikit::select_field("a11y-select",if self.second_input {"Input 2"}else{"Input 1"})
                .aria_label("Input device").aria_expanded(self.select_open)
                .on_click(cx.listener(|p,_,_,cx|{p.select_open=!p.select_open;cx.notify();})))
                .when(self.select_open,|container|container.child(singz_uikit::select_popup()
                    .child(singz_uikit::select_option("a11y-input-first","Input 1",!self.second_input)
                        .on_click(cx.listener(|p,_,_,cx|{p.second_input=false;p.select_open=false;cx.notify();})))
                    .child(singz_uikit::select_option("a11y-input-second","Input 2",self.second_input)
                        .on_click(cx.listener(|p,_,_,cx|{p.second_input=true;p.select_open=false;cx.notify();}))))))
            .child(div().w(px(220.)).child(singz_uikit::song_button_with_focus(
                pill("a11y-disabled","Unavailable action",false),self.disabled_focus.clone(),false,
                {let owner=owner.clone();move |_,cx|owner.update(cx,|p,cx|{p.presses+=100;cx.notify();})})))
            .child(div().w(px(300.)).child(singz_uikit::settings_range_slider_with_focus(
                "a11y-gain",self.gain,-60.,0.,1.,self.gain_focus.clone(),true,
                {let owner=owner.clone();move |value,_,cx|owner.update(cx,|p,cx|{p.gain=value;p.changed+=1;cx.notify();})})
                .aria_label("Monitoring gain")))
            .child(div().w(px(300.)).child(singz_uikit::training_range_with_focus(
                "a11y-training-gain",self.training_gain,0.,1.,0.05,self.training_focus.clone(),true,
                {let owner=owner.clone();move |value,_,cx|owner.update(cx,|p,cx|{p.training_gain=value;p.training_changed+=1;cx.notify();})})
                .aria_label("Training cue volume")))
            .child(div().w(px(300.)).child(singz_uikit::song_output_fader(
                "a11y-output-gain",self.output_gain,
                {let owner=owner.clone();move |value,_,cx|owner.update(cx,|p,cx|{p.output_gain=value;p.output_changed+=1;cx.notify();})})
                .track_focus(&self.output_focus).tab_index(0).aria_label("Song output gain")))
            .child(div().w(px(300.)).child(singz_uikit::settings_range_slider_with_focus(
                "a11y-disabled-gain",-18.,-60.,0.,1.,self.disabled_focus.clone(),false,
                move |_,_,cx|owner.update(cx,|p,cx|{p.changed+=100;cx.notify();}))
                .aria_label("Unavailable monitoring gain")))
            .when(self.modal,|root|root.child(singz_uikit::modal_scrim().child(
                singz_uikit::modal_card().w(px(300.)).child("Modal blocks background controls"))))
    }
}
fn selector_expanded(window: &Window) -> anyhow::Result<bool> {
    let tree:serde_json::Value=serde_json::from_str(&window.debug_a11y_tree_json().ok_or_else(||anyhow::anyhow!("Actual tree missing"))?)?;
    let node=tree["nodes"].as_object().and_then(|nodes|nodes.values().find(|node|node["aria"]["label"]=="Input device"))
        .ok_or_else(||anyhow::anyhow!("Actual selector accessibility node missing"))?;
    node["aria"]["expanded"].as_bool().ok_or_else(||anyhow::anyhow!("Actual selector expanded state missing"))
}
fn tree_frame(window: &Window) -> anyhow::Result<u64> {
    let tree:serde_json::Value=serde_json::from_str(&window.debug_a11y_tree_json().ok_or_else(||anyhow::anyhow!("Actual tree missing"))?)?;
    tree["frame"]["frame_number"].as_u64().ok_or_else(||anyhow::anyhow!("Actual tree frame identity missing"))
}

fn actual_node_id(window: &Window, id: &str) -> anyhow::Result<gpui_kit::accesskit::NodeId> {
    let tree:serde_json::Value=serde_json::from_str(&window.debug_a11y_tree_json().ok_or_else(||anyhow::anyhow!("Actual tree missing"))?)?;
    let nodes=tree["nodes"].as_object().ok_or_else(||anyhow::anyhow!("Actual tree has no nodes"))?;
    // The framework's provenance field uses ElementId's Debug format; retain
    // the actual tree-supplied AccessKit ID rather than deriving a new one.
    // That field exists only where debug assertions are on. A release or qualify
    // ui-tests build has no `element_id`, so there the node is the one slider that
    // carries this control's accessible name: the tree still states role and label.
    let element_id=format!("{:?}",ElementId::from(id.to_owned()));
    let by_id:Vec<_>=nodes.values().filter(|node|node["element_id"]==element_id).collect();
    let node=if let [node]=by_id.as_slice() {*node} else {
        let label=match id {"a11y-gain"=>"Monitoring gain","a11y-training-gain"=>"Training cue volume","a11y-output-gain"=>"Song output gain",_=>anyhow::bail!("Actual accessibility node missing: {id}")};
        let by_label:Vec<_>=nodes.values().filter(|node|node["aria"]["role"]=="Slider"&&node["aria"]["label"]==label).collect();
        match by_label.as_slice() {
            [node]=>*node,
            found=>anyhow::bail!("Actual accessibility node missing: {id} ({} by element id, {} sliders named {label:?})",by_id.len(),found.len()),
        }
    };
    let raw=node["accesskit_id"].as_str().ok_or_else(||anyhow::anyhow!("Actual node identity missing: {id}"))?;
    Ok(gpui_kit::accesskit::NodeId(raw.parse()?))
}
fn diagnostic(host: &Entity<Controls>, w: &Window, cx: &App, out: &Path, phase: &str, error: Option<&str>) -> anyhow::Result<()> {
    let tree=w.debug_a11y_tree_json();
    if let Some(tree)=&tree {std::fs::write(out.join(format!("{phase}.diagnostic-tree.json")),tree)?;}
    let native:Vec<_>=unsafe { native_nodes() }.into_iter().map(|(_,v)|v).collect();
    std::fs::write(out.join(format!("{phase}.diagnostic.json")),serde_json::to_vec_pretty(&serde_json::json!({
        "phase":phase,"error":error,"state":host.read(cx).state(),"nativeAX":native,
        "a11yActive":w.is_a11y_active(),"hidden":!w.is_visible()&&!w.is_window_active(),
        "viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),
        "treePresent":tree.is_some(),"liveFPS":"unmeasured"}))?)?;
    Ok(())
}
fn snapshot(host: &Entity<Controls>, w: &mut Window, cx: &mut App, out: &Path, name: &str) -> anyhow::Result<()> {
        draw(w,cx);anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Accessibility test activated window");
        anyhow::ensure!(w.is_a11y_active(),"Real platform accessibility adapter inactive");
        let tree=w.debug_a11y_tree_json().ok_or_else(||anyhow::anyhow!("Actual tree missing"))?;
        std::fs::write(out.join(format!("{name}.tree.json")),tree)?;
        let native:Vec<_>=unsafe { native_nodes() }.into_iter().map(|(_,v)|v).collect();
        let path=out.join(format!("{name}.png"));w.render_to_image()?.save(&path)?;
        std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&serde_json::json!({
            "scope":"Actual native macOS AX objects driving shared UIKit controls in an isolated host; not whole app/accessibility certification",
            "state":host.read(cx).state(),"nativeAX":native,"hidden":!w.is_visible()&&!w.is_window_active(),
            "viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),
            "screenshot":path,"screenshotSha256":hash(&std::fs::read(path)?),
            "liveFPS":"unmeasured"}))?)?;Ok(())
}
pub fn run(handle: AnyWindowHandle, _view: Entity<Player>, out: PathBuf, cx: &mut App) {
    let host=handle.update(cx,|_,w,cx|{
        w.set_window_title(TITLE);
        w.replace_root(cx,|_,cx|Controls::new(cx))
    }).expect("Replace hidden test root");
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&out)?;
            let mut cases=vec![];
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,cx|{w.resize(size(px(width),px(height)));host.update(cx,|p,cx|{p.presses=0;p.switch=false;p.gain=-18.;p.changed=0;p.modal=false;p.training_gain=0.5;p.training_changed=0;p.output_gain=-6.;p.output_changed=0;p.checked=false;p.second_tab=false;p.links=0;p.select_open=false;p.second_input=false;cx.notify();});draw(w,cx);})?;
                let deadline=Instant::now()+Duration::from_secs(12);
                loop {
                    handle.update(cx,|_,w,cx|{draw(w,cx);unsafe { native_nodes() };})?;
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,w,cx|{draw(w,cx);w.viewport_size()==size(px(width),px(height))&&w.is_a11y_active()&&unsafe { native_nodes() }.len()>=11})?;
                    if ready {break;} anyhow::ensure!(Instant::now()<deadline,"Native AX activation timed out");
                }
                handle.update(cx,|_,w,cx|diagnostic(&host,w,cx,&out,&format!("initialized-{}",width as u32),None))??;
                let native=handle.update(cx,|_,_,_|unsafe{native_nodes()}.into_iter().map(|(_,v)|v).collect::<Vec<_>>())?;
                for (id,role,title) in [("a11y-press","AXButton","Add track"),("a11y-switch","AXCheckBox","Monitoring"),("a11y-gain","AXSlider","Monitoring gain"),("a11y-check","AXCheckBox","Loop practice"),("a11y-tab-second","AXRadioButton","Devices"),("a11y-link","AXLink","Help"),("a11y-select","AXPopUpButton","Input device"),("a11y-training-gain","AXSlider","Training cue volume"),("a11y-output-gain","AXSlider","Song output gain")] {
                    let row=native.iter().find(|v|v["id"]==id).ok_or_else(||anyhow::anyhow!("Native AX row missing {id}"))?;
                    anyhow::ensure!(row["role"]==role&&row["title"]==title,"Native AX semantics differ: {row}");
                }
                let gain=native.iter().find(|v|v["id"]=="a11y-gain").unwrap();
                anyhow::ensure!(gain["value"]==-18.&&gain["min"]==-60.&&gain["max"]==0.,"Native AX numeric range differs: {gain}");
                let output=native.iter().find(|v|v["id"]=="a11y-output-gain").unwrap();
                anyhow::ensure!(output["value"]==-6.&&output["min"]==-60.&&output["max"]==12.,"Native AX output range differs: {output}");
                // A real native popup action opens the actual shared popup;
                // selecting its actual option changes the controlled value.
                handle.update(cx,|_,_,_|->anyhow::Result<()>{anyhow::ensure!(native_action("a11y-select","accessibilityPerformPress",None)?,"AX selector refused");Ok(())})??;
                cx.background_executor().timer(Duration::from_millis(60)).await;
                let native_expanded_open=handle.update(cx,|_,w,cx|->anyhow::Result<serde_json::Value>{draw(w,cx);anyhow::ensure!(host.read(cx).select_open&&selector_expanded(w)?,"AX selector did not open popup/expanded tree state");
                    let rows=unsafe { native_nodes() };let (_,row)=rows.iter().find(|(_,v)|v["id"]=="a11y-select").unwrap();let value=row["expanded"].clone();
                    anyhow::ensure!(native_action("a11y-input-second","accessibilityPerformPress",None)?,"AX option refused");Ok(value)})??;
                cx.background_executor().timer(Duration::from_millis(60)).await;
                let native_expanded_closed=handle.update(cx,|_,w,cx|->anyhow::Result<serde_json::Value>{draw(w,cx);anyhow::ensure!(host.read(cx).second_input&&!host.read(cx).select_open&&!selector_expanded(w)?,"AX option did not select/close/clear expanded tree state");
                    let rows=unsafe { native_nodes() };let (_,selected)=rows.iter().find(|(_,v)|v["id"]=="a11y-select").unwrap();
                    anyhow::ensure!(selected["value"]=="Input 2","Native AX selection value differs: {selected}");
                    for id in ["a11y-check","a11y-tab-second","a11y-link"] {anyhow::ensure!(native_action(id,"accessibilityPerformPress",None)?,"AX action refused: {id}");}Ok(selected["expanded"].clone())})??;
                cx.background_executor().timer(Duration::from_millis(60)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(host.read(cx).checked&&host.read(cx).second_tab&&host.read(cx).links==1,"Native checkbox/tab/link actions differ");
                    let rows=unsafe { native_nodes() };for id in ["a11y-check","a11y-tab-second"] {let (_,row)=rows.iter().find(|(_,v)|v["id"]==id).unwrap();anyhow::ensure!(row["value"]==1.,"Native AX selected/toggled value differs: {row}");}Ok(())})??;
                let mut mixed=vec![];
                for control in ["settings","training","output"] {
                    let training=control=="training";let output=control=="output";
                    let before=handle.update(cx,|_,w,cx|->anyhow::Result<u64>{
                        let focus=if training {host.read(cx).training_focus.clone()}else if output {host.read(cx).output_focus.clone()}else{host.read(cx).gain_focus.clone()};
                        focus.focus(w,cx);draw(w,cx);let frame=tree_frame(w)?;
                        w.dispatch_keystroke(Keystroke::parse("right").unwrap(),cx);
                        anyhow::ensure!(if training {(host.read(cx).training_gain-0.55).abs()<0.00001}else if output {host.read(cx).output_gain==-5.5}else{host.read(cx).gain==-17.},"Keyboard part of mixed burst failed");
                        anyhow::ensure!(native_action(if training {"a11y-training-gain"}else if output {"a11y-output-gain"}else{"a11y-gain"},"accessibilityPerformIncrement",None)?,"AX mixed increment refused");Ok(frame)
                    })??;
                    let deadline=Instant::now()+Duration::from_secs(3);
                    let after=loop {
                        // Real OS delivery is asynchronous. Yield without a manual
                        // draw, but record any legitimate framework redraw.
                        cx.background_executor().timer(Duration::from_millis(10)).await;
                        let value=handle.update(cx,|_,w,cx|->anyhow::Result<Option<u64>>{
                            let ready=if training {(host.read(cx).training_gain-0.60).abs()<0.00001}else if output {host.read(cx).output_gain==-5.0}else{host.read(cx).gain==-16.};
                            let frame=tree_frame(w)?;
                            Ok(ready.then_some(frame))
                        })??;
                        if let Some(frame)=value {break frame;}anyhow::ensure!(Instant::now()<deadline,"Mixed keyboard/AX burst lost an increment");
                    };
                    mixed.push(serde_json::json!({"control":control,"step":if training {0.05}else if output {0.5}else{1.0},"beforeTreeFrame":before,"afterTreeFrame":after,"sameFrame":before==after,"nativeOSDelivery":true,"beforePaintObserved":before==after}));
                }
                handle.update(cx,|_,w,cx|{host.update(cx,|p,cx|{p.gain=-18.;p.changed=0;p.training_gain=0.5;p.training_changed=0;p.output_gain=-6.;p.output_changed=0;cx.notify();});draw(w,cx);})?;
                let mut framework_mixed=vec![];
                for control in ["settings","training","output"] {
                    let row=handle.update(cx,|_,w,cx|->anyhow::Result<serde_json::Value>{
                        let training=control=="training";let output=control=="output";
                        let focus=if training {host.read(cx).training_focus.clone()}else if output {host.read(cx).output_focus.clone()}else{host.read(cx).gain_focus.clone()};
                        focus.focus(w,cx);draw(w,cx);
                        let id=if training {"a11y-training-gain"}else if output {"a11y-output-gain"}else{"a11y-gain"};
                        let node=actual_node_id(w,id)?;let before=tree_frame(w)?;
                        w.dispatch_keystroke(Keystroke::parse("right").unwrap(),cx);
                        anyhow::ensure!(if training {(host.read(cx).training_gain-0.55).abs()<0.00001}else if output {host.read(cx).output_gain==-5.5}else{host.read(cx).gain==-17.},"Framework keyboard part failed");
                        w.dispatch_accessibility_action(gpui_kit::accesskit::ActionRequest {
                            action:AccessibleAction::Increment,target_tree:gpui_kit::accesskit::TreeId::ROOT,target_node:node,data:None,
                        },cx);
                        let after=tree_frame(w)?;
                        anyhow::ensure!(before==after,"Synchronous framework burst unexpectedly repainted");
                        anyhow::ensure!(if training {(host.read(cx).training_gain-0.60).abs()<0.00001&&host.read(cx).training_changed==2}else if output {host.read(cx).output_gain==-5.0&&host.read(cx).output_changed==2}else{host.read(cx).gain==-16.&&host.read(cx).changed==2},"Framework before-paint burst lost an increment");
                        Ok(serde_json::json!({"control":control,"step":if training {0.05}else if output {0.5}else{1.0},"beforeTreeFrame":before,"afterTreeFrame":after,"sameFrame":true,"nativeOSDelivery":false,"actualNodeId":node.0.to_string(),"scope":"Synchronous test-support dispatch through production framework action handler; not native OS event delivery"}))
                    })??;
                    framework_mixed.push(row);
                }
                // The standalone native action cases below start from their own
                // explicit fixture state after both independent mixed-input checks.
                handle.update(cx,|_,w,cx|{host.update(cx,|p,cx|{p.gain=-18.;p.changed=0;p.training_gain=0.5;p.training_changed=0;p.output_gain=-6.;p.output_changed=0;cx.notify();});draw(w,cx);})?;
                handle.update(cx,|_,_,_|->anyhow::Result<()>{anyhow::ensure!(native_action("a11y-press","accessibilityPerformPress",None)?,"AX press refused");Ok(())})??;
                cx.background_executor().timer(Duration::from_millis(60)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(host.read(cx).presses==1,"AX press did not activate exactly once");anyhow::ensure!(native_action("a11y-switch","accessibilityPerformPress",None)?,"AX toggle refused");Ok(())})??;
                cx.background_executor().timer(Duration::from_millis(60)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(host.read(cx).switch,"AX toggle did not update actual state");anyhow::ensure!(native_action("a11y-gain","accessibilityPerformIncrement",None)?,"AX increment refused");Ok(())})??;
                cx.background_executor().timer(Duration::from_millis(60)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(host.read(cx).gain==-17.,"AX increment differs");anyhow::ensure!(native_action("a11y-gain","accessibilityPerformDecrement",None)?,"AX decrement refused");Ok(())})??;
                cx.background_executor().timer(Duration::from_millis(60)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(host.read(cx).gain==-18.,"AX decrement differs");native_action("a11y-gain","setAccessibilityValue:",Some(-12.4))?;Ok(())})??;
                cx.background_executor().timer(Duration::from_millis(60)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(host.read(cx).gain==-12.,"AX SetValue did not use controlled quantization");
                    let rows=unsafe{native_nodes()};for id in ["a11y-disabled","a11y-disabled-gain"] {let (_,v)=rows.iter().find(|(_,v)|v["id"]==id).unwrap();anyhow::ensure!(v["enabled"]==false,"Disabled AX control enabled: {v}");}
                    anyhow::ensure!(!native_action("a11y-disabled","accessibilityPerformPress",None)?,"Disabled AX press admitted");
                    anyhow::ensure!(!native_action("a11y-disabled-gain","accessibilityPerformIncrement",None)?,"Disabled AX increment admitted");
                    native_action("a11y-disabled-gain","setAccessibilityValue:",Some(-6.))?;
                    native_action("a11y-gain","setAccessibilityValue:",Some(f64::NAN))?;Ok(())})??;
                cx.background_executor().timer(Duration::from_millis(60)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(host.read(cx).presses==1&&host.read(cx).changed==3,"Disabled action mutated controls");snapshot(&host,w,cx,&out,&format!("controls-{}",width as u32))})??;
                handle.update(cx,|_,w,cx|{host.update(cx,|p,cx|{p.modal=true;cx.notify();});draw(w,cx);})?;
                handle.update(cx,|_,_,_|->anyhow::Result<()>{native_action("a11y-press","accessibilityPerformPress",None)?;native_action("a11y-gain","accessibilityPerformIncrement",None)?;native_action("a11y-gain","setAccessibilityValue:",Some(-6.))?;Ok(())})??;
                cx.background_executor().timer(Duration::from_millis(80)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(host.read(cx).presses==1&&host.read(cx).gain==-12.&&host.read(cx).changed==3,"Modal allowed native background activation");snapshot(&host,w,cx,&out,&format!("modal-blocked-{}",width as u32))})??;
                cases.push(serde_json::json!({"width":width,"nativeAXPress":true,"nativeAXToggle":true,"nativeAXIncrementDecrementSetValue":true,"disabledRefused":true,"modalBackgroundRefused":true,"nativeAXSelect":true,"nativeAXCheckboxTabLink":true,"nativeMixedKeyboardAX":mixed,"frameworkSameFrameMixed":framework_mixed,
                    "selectorExpanded":{"gpuiTreeOpen":true,"gpuiTreeClosed":false,"nativeGetterOpen":native_expanded_open,"nativeGetterClosed":native_expanded_closed,"nativeExpandedQualified":false,"limitation":"Pinned macOS adapter has no explicit expanded-state bridge; inherited/unsupported getter is not qualification"}}));
            }
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"passed":true,"scope":"shared UIKit isolated host, real native macOS AX; not whole-app/accessibility certification","cases":cases,"hidden":true,"liveFPS":"unmeasured","compiledUikitSource":env!("SINGZ_UIKIT_SOURCE"),"compiledAdapterSha256":hash(include_bytes!("ui_accessibility.rs"))}))?)?;
            // Explicit observation tail for independent process/resource sampling.
            cx.background_executor().timer(Duration::from_secs(2)).await;
            Ok(())
        }.await;
        match result {Ok(())=>eprintln!("ACCESSIBILITY passed"),Err(error)=>{
            eprintln!("ACCESSIBILITY failed: {error:#}");let detail=format!("{error:#}");
            if let Err(failure)=handle.update(cx,|_,w,cx|diagnostic(&host,w,cx,&out,"failure",Some(&detail))).and_then(|r|r) {
                eprintln!("ACCESSIBILITY diagnostic failed: {failure:#}");
            }
        }};
        let _=cx.update(|cx|cx.quit());
    }).detach();
}
