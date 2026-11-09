//! Transport's Restart alternates selection start/song start until its inputs change.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Inputs {
    selection: Option<(f32, f32)>,
    playing: bool,
}
#[derive(Clone, Debug, Default)]
pub struct RestartCycle {
    inputs: Option<Inputs>,
    start_at_song: bool,
    component: u64,
    mounted: bool,
}
impl RestartCycle {
    pub fn reset(&mut self) {self.start_at_song=false;}
    pub fn observe_component(&mut self, mounted:bool) {
        if mounted!=self.mounted {
            self.reset();self.component+=1;self.mounted=mounted;
        }
    }
    pub fn snapshot(&self, selection:Option<(f32,f32)>, playing:bool)->Self {
        let mut snapshot=self.clone();
        snapshot.observe(selection,playing);
        snapshot
    }
    pub fn restore_same_song(&mut self, snapshot:Self, selection:Option<(f32,f32)>, playing:bool)->bool {
        let inputs=Inputs{selection,playing};
        if self.mounted && self.component==snapshot.component && snapshot.inputs==Some(inputs) {
            *self=snapshot;true
        } else {
            self.observe(selection,playing);false
        }
    }
    pub fn observe(&mut self, selection:Option<(f32,f32)>, playing:bool) {
        let inputs=Inputs{selection,playing};
        if self.inputs!=Some(inputs) {self.reset();self.inputs=Some(inputs);}
    }
    pub fn next(&mut self, selection:Option<(f32,f32)>, playing:bool)->f32 {
        self.observe(selection,playing);
        let target=selection.filter(|_|!self.start_at_song).map_or(0.,|(start,_)|start);
        self.start_at_song=selection.is_some()&&!self.start_at_song;
        target
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn restart_alternates_selection_and_song_without_selection_seeks_zero() {
        let mut cycle=RestartCycle::default();let selection=Some((2.,5.));
        assert_eq!(cycle.next(selection,false),2.);
        assert_eq!(cycle.next(selection,false),0.);
        assert_eq!(cycle.next(selection,false),2.);
        assert_eq!(cycle.next(None,false),0.);
        assert_eq!(cycle.next(None,false),0.);
    }
    #[test] fn selection_and_each_playing_transition_reset_the_cycle() {
        let mut cycle=RestartCycle::default();let selection=Some((2.,5.));
        assert_eq!(cycle.next(selection,false),2.);
        assert_eq!(cycle.next(Some((3.,5.)),false),3.);
        // A new Player/engine owns a fresh cycle rather than a song epoch.
        cycle=RestartCycle::default();
        assert_eq!(cycle.next(selection,false),2.);
        assert_eq!(cycle.next(selection,true),2.);
        assert_eq!(cycle.next(selection,false),2.);
        cycle.observe(selection,true);cycle.observe(selection,false);
        assert_eq!(cycle.next(selection,false),2.);
    }
    #[test] fn republishing_equal_selection_resets_without_resetting_on_seek() {
        let mut cycle=RestartCycle::default();let selection=Some((2.,5.));
        assert_eq!(cycle.next(selection,false),2.);
        cycle.observe(selection,false);
        assert_eq!(cycle.next(selection,false),0.);
        cycle.reset();
        assert_eq!(cycle.next(selection,false),2.);
    }
    #[test] fn same_song_handoff_preserves_cycle_only_for_unchanged_visible_inputs() {
        let mut cycle=RestartCycle::default();let selection=Some((2.,5.));
        cycle.observe_component(true);
        assert_eq!(cycle.next(selection,true),2.);
        let captured=cycle.snapshot(selection,true);
        // Reopening the same native graph temporarily pauses it, then resumes.
        cycle.observe(selection,false);cycle.observe(selection,true);
        assert!(cycle.restore_same_song(captured.clone(),selection,true));
        assert_eq!(cycle.next(selection,true),0.);
        assert!(!cycle.restore_same_song(captured.clone(),selection,false));
        assert_eq!(cycle.next(selection,false),2.);
        assert!(!cycle.restore_same_song(captured.clone(),Some((3.,5.)),true));
        assert_eq!(cycle.next(Some((3.,5.)),true),3.);
        cycle.observe_component(false);cycle.observe_component(true);
        assert!(!cycle.restore_same_song(captured,selection,true));
        assert_eq!(cycle.next(selection,true),2.);
    }
}
