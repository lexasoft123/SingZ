//! Ruler composition geometry, resolved within one layout/prepaint pass.
use gpui_kit::*;
use std::{cell::Cell, rc::Rc};
#[cfg(feature = "ui-tests")]
use std::cell::RefCell;

#[derive(Default)]
pub struct Frame {
    zoom_layout: Cell<Option<LayoutId>>,
    #[cfg(feature = "ui-tests")]
    labels: RefCell<Vec<serde_json::Value>>,
    #[cfg(feature = "ui-tests")]
    zoom_bounds: Cell<Option<Bounds<Pixels>>>,
}

impl Frame {
    pub fn zoom(self: &Rc<Self>, child: impl IntoElement) -> RulerElement {
        RulerElement { child: child.into_any_element(), frame: self.clone(), tick: None, column_right: px(0.) }
    }
    pub fn label(self: &Rc<Self>, text: String, child: impl IntoElement, column_right: Pixels) -> RulerElement {
        RulerElement { child: child.into_any_element(), frame: self.clone(), tick: Some(text), column_right }
    }
    #[cfg(feature = "ui-tests")]
    pub fn evidence(&self) -> serde_json::Value {
        serde_json::json!({"measurement":"same-frame shaped text and zoom layout", "labels":*self.labels.borrow(),
            "zoomGroup":self.zoom_bounds.get().map(|b|serde_json::json!({"left":f32::from(b.left()),"right":f32::from(b.right()),"width":f32::from(b.size.width)}))})
    }
}

pub struct RulerElement {
    child: AnyElement,
    frame: Rc<Frame>,
    tick: Option<String>,
    column_right: Pixels,
}
impl IntoElement for RulerElement {
    type Element = Self;
    fn into_element(self) -> Self { self }
}
impl Element for RulerElement {
    type RequestLayoutState = ();
    type PrepaintState = bool;
    fn id(&self) -> Option<ElementId> { None }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> { None }
    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, w: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        let layout = self.child.request_layout(w, cx);
        if self.tick.is_none() { self.frame.zoom_layout.set(Some(layout)); }
        (layout, ())
    }
    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), w: &mut Window, cx: &mut App) -> bool {
        let admitted = if self.tick.is_some() {
            // Every sibling has requested layout before prepaint begins. Only
            // the width is queried: the zoom sibling's absolute origin has not
            // necessarily been prepainted yet. Its right inset is 22px.
            let width = w.layout_bounds(self.frame.zoom_layout.get().expect("ruler zoom layout requested")).size.width;
            let group_left = self.column_right - px(22.) - width;
            let admitted = bounds.right() <= group_left;
            #[cfg(feature = "ui-tests")]
            self.frame.labels.borrow_mut().push(serde_json::json!({
                "text":self.tick,"left":f32::from(bounds.left()),"right":f32::from(bounds.right()),
                "width":f32::from(bounds.size.width),"zoomWidth":f32::from(width),
                "groupLeft":f32::from(group_left),"admitted":admitted
            }));
            admitted
        } else {
            #[cfg(feature = "ui-tests")]
            self.frame.zoom_bounds.set(Some(bounds));
            true
        };
        if admitted { self.child.prepaint(w, cx); }
        admitted
    }
    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (), admitted: &mut bool, w: &mut Window, cx: &mut App) {
        if *admitted { self.child.paint(w, cx); }
    }
}
