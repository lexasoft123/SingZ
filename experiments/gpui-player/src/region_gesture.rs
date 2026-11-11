//! TrackStack's pointer selection rules, independent of the renderer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Target {
    pub selection: Option<(f64, f64)>,
    pub looping: bool,
}
impl Target {
    pub fn command(self, duration: f64) -> String {
        match self.selection.or_else(|| self.looping.then_some((0., duration))) {
            Some((s, e)) => format!("region {s} {e} {}", u8::from(self.looping)),
            None => "unregion".into(),
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Gesture {
    pub epoch: u64,
    x0: f32,
    left: f32,
    width: f32,
    start: f64,
    end: f64,
    anchor: f64,
    resize: bool,
    selecting: bool,
}
impl Gesture {
    pub fn begin(epoch: u64, x: f32, left: f32, width: f32, start: f64, end: f64, selection: Option<(f64,f64)>) -> Option<Self> {
        if ![x,left,width].iter().all(|v|v.is_finite()) || !start.is_finite() || !end.is_finite() || width <= 0. || end <= start { return None; }
        let edge = selection.and_then(|(s,e)| {
            let ds=(x-(left+((s-start)/(end-start)) as f32*width)).abs();
            let de=(x-(left+((e-start)/(end-start)) as f32*width)).abs();
            (ds<=6. || de<=6.).then_some(if ds<=de {e} else {s})
        });
        let mut gesture=Self {epoch,x0:x,left,width,start,end,anchor:0.,resize:edge.is_some(),selecting:edge.is_some()};
        gesture.anchor=edge.unwrap_or_else(||gesture.time(x));
        Some(gesture)
    }
    fn time(&self, x:f32)->f64 { self.start+(((x-self.left) as f64/self.width as f64).clamp(0.,1.))*(self.end-self.start) }
    pub fn moved(&mut self, x:f32)->Option<(f64,f64)> {
        if !x.is_finite() || (!self.selecting && (x-self.x0).abs()<5.) {return None;}
        self.selecting=true;
        let time=self.time(x);
        // A zero-width drag is not a valid native playback region.
        (time!=self.anchor).then_some((self.anchor.min(time),self.anchor.max(time)))
    }
    pub fn clicked(self)->Option<f64> { (!self.resize && !self.selecting).then_some(self.anchor) }
    pub fn resizing(self)->bool {self.resize}
}
#[cfg(test)]
mod tests {
    use super::*;
    fn begin(x:f32, selection:Option<(f64,f64)>)->Gesture {Gesture::begin(7,x,0.,100.,0.,10.,selection).unwrap()}
    #[test] fn click_and_drag_threshold() {
        let mut g=begin(20.,None);assert_eq!(g.moved(24.9),None);assert_eq!(g.clicked(),Some(2.));
        assert_eq!(g.moved(25.),Some((2.,2.5)));assert_eq!(g.clicked(),None);
        assert_eq!(g.moved(-50.),Some((0.,2.)));
    }
    #[test] fn both_edges_cross_and_resize_click_does_not_seek() {
        let mut start=begin(21.,Some((2.,8.)));assert_eq!(start.clicked(),None);
        assert_eq!(start.moved(90.),Some((8.,9.)));
        let mut end=begin(79.,Some((2.,8.)));assert_eq!(end.moved(10.),Some((1.,2.)));
        let mut tie=begin(50.,Some((4.5,5.5)));assert_eq!(tie.moved(20.),Some((2.,5.5)));
    }
    #[test] fn commands_keep_selection_when_loop_is_off() {
        assert_eq!(Target{selection:Some((2.,8.)),looping:false}.command(10.),"region 2 8 0");
        assert_eq!(Target{selection:None,looping:true}.command(10.),"region 0 10 1");
        assert_eq!(Target{selection:None,looping:false}.command(10.),"unregion");
    }
}

#[cfg(test)]
#[path="region_gesture_timeline_tests.rs"]
mod timeline_tests;
