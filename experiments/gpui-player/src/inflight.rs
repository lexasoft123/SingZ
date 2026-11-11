#[derive(Debug)]
pub(super) struct Inflight<T> { serial: u64, current: Option<(u64, u64, T)> }
impl<T> Default for Inflight<T> { fn default() -> Self { Self { serial: 0, current: None } } }
impl<T> Inflight<T> {
    pub fn reserve(&mut self) -> u64 { self.serial += 1; self.serial }
    pub fn activate(&mut self, epoch: u64, serial: u64, payload: T) { self.current = Some((epoch, serial, payload)); }
    pub fn begin(&mut self, epoch: u64, payload: T) -> u64 { let serial = self.reserve(); self.activate(epoch, serial, payload); serial }
    pub fn settle(&mut self, epoch: u64, serial: u64) -> Option<T> {
        if !self.current.as_ref().is_some_and(|(e, s, _)| *e == epoch && *s == serial) { return None; }
        self.current.take().map(|(_, _, payload)| payload)
    }
    /// Records a serial chosen by the caller (it was only committed once the
    /// command was accepted) and puts the payload in flight under it.
    pub fn begin_at(&mut self, epoch: u64, serial: u64, payload: T) { self.serial = serial; self.activate(epoch, serial, payload); }
    /// Records a serial chosen by the caller and leaves nothing in flight.
    pub fn retire_at(&mut self, serial: u64) { self.serial = serial; self.current = None; }
    pub fn serial(&self) -> u64 { self.serial }
    pub fn current_serial(&self) -> Option<u64> { self.current.as_ref().map(|(_, s, _)| *s) }
    pub fn is_current(&self, serial: u64) -> bool { self.current_serial() == Some(serial) }
    /// Settles by serial alone, for receipts that do not carry an epoch.
    pub fn settle_serial(&mut self, serial: u64) -> Option<T> {
        if !self.is_current(serial) { return None; }
        self.current.take().map(|(_, _, payload)| payload)
    }
    pub fn current(&self) -> Option<(u64, u64, &T)> { self.current.as_ref().map(|(e, s, p)| (*e, *s, p)) }
    pub fn key(&self) -> Option<(u64, u64)> { self.current.as_ref().map(|(e, s, _)| (*e, *s)) }
    pub fn payload(&self) -> Option<&T> { self.current.as_ref().map(|(_, _, payload)| payload) }
    /// Cancels and returns what was in flight, as `(epoch, serial, payload)`.
    pub fn take(&mut self) -> Option<(u64, u64, T)> { self.current.take() }
    pub fn cancel(&mut self) { self.current = None; }
    pub fn busy(&self) -> bool { self.current.is_some() }
    pub fn is_some(&self) -> bool { self.busy() }
    pub fn is_none(&self) -> bool { !self.busy() }
}

#[derive(Default)]
pub(super) struct QueuedLoop(Option<crate::region_gesture::Target>);
impl QueuedLoop {
    pub fn toggle(&mut self, current: crate::region_gesture::Target) {
        let target = self.0.unwrap_or(current);
        self.0 = Some(crate::region_gesture::Target { looping: !target.looping, ..target });
    }
    pub fn take(&mut self) -> Option<crate::region_gesture::Target> { self.0.take() }
}

impl<T> serde::Serialize for Inflight<T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serde::Serialize::serialize(&self.current.as_ref().map(|(epoch, serial, _)| (*epoch, *serial)), serializer)
    }
}
