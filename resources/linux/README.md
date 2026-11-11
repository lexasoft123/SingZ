# Opt-in persistent Box audio

These support files target the Debian package installed at `/opt/singz-box`.
They do not install, enable or modify a live service automatically. Packaging
must copy this directory outside the asar to `resources/box-audio`.

Copy `singz-box-audio.service` into `~/.config/systemd/user/`, then run
`systemctl --user daemon-reload`. Enable the unit only when this machine is
intended to keep audio alive independently of the TV UI. Launch
`/opt/singz-box/resources/box-audio/singz-box-with-audio` to opt the UI into the
service. Ordinary Box and Desktop launchers keep their existing audio lifetime.
For relocatable/AppImage installs, adjust the unit ExecStart to the absolute
installed executable; do not use shell expansion in ExecStart.

The service uses an isolated `SingZ Box Audio` data profile and a private runtime
socket. Closing the UI only disconnects controls. Microphone analysis, public playback
and routing remain in the service; analysis restarts from its saved input
selection whenever the service starts and stops only when every input is off.
`systemctl --user stop singz-box-audio` explicitly drains the audio owners.
The unit uses `RuntimeDirectoryPreserve=no`, so systemd removes the service's
runtime directory when it stops, including during supervised restart. Startup
refuses every existing socket, including an apparently stale one; it never
probes then deletes a pathname that another process could acquire meanwhile.
For manual execution after an abnormal exit, first prove that the previous host
and all its descendants have stopped, then remove its abandoned socket from the
private runtime directory before launching again. Do not remove a live socket
or use socket deletion as an audio-host takeover mechanism.
zCore's ALSA I/O threads and the song producer request `SCHED_FIFO` (at most
priority 20). The unit sets `LimitRTPRIO=20`, but a user manager can only raise
it to its own hard limit, which is 0 by default; the threads then log a warning
and run at normal priority. On an appliance, copy `singz-box-rtprio.conf` to
`/etc/systemd/system/user@<UID>.service.d/` for the appliance user only, then
`systemctl daemon-reload` and restart that user's manager (or reboot). It grants
a hard limit of 20 with soft limit 0, so nothing else becomes real-time unless
it asks. Do not use `--no-sandbox`, run the service as root, or grant `@audio`
system-wide.
No default route is created: configure and verify the chosen hardware topology
through trusted TV settings. FLOW 8 hardware monitoring and analog MAIN output
remain the intended default; HDMI carries video.

This is an Electron main-process headless mode (no BrowserWindow), not a browser
page. The deployed Electron build's headless platform support still requires a
real Linux package smoke test. Do not add `--no-sandbox` to work around setup.
