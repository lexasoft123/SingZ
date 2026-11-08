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
socket. Closing the UI disconnects controls and releases private microphone
analysis/monitoring; public playback and routing remain in the service.
`systemctl --user stop singz-box-audio` explicitly drains the audio owners.
The unit uses `RuntimeDirectoryPreserve=no`, so systemd removes the service's
runtime directory when it stops, including during supervised restart. Startup
refuses every existing socket, including an apparently stale one; it never
probes then deletes a pathname that another process could acquire meanwhile.
For manual execution after an abnormal exit, first prove that the previous host
and all its descendants have stopped, then remove its abandoned socket from the
private runtime directory before launching again. Do not remove a live socket
or use socket deletion as an audio-host takeover mechanism.
No default route is created: configure and verify the chosen hardware topology
through trusted TV settings. FLOW 8 hardware monitoring and analog MAIN output
remain the intended default; HDMI carries video.

This is an Electron main-process headless mode (no BrowserWindow), not a browser
page. The deployed Electron build's headless platform support still requires a
real Linux package smoke test. Do not add `--no-sandbox` to work around setup.
