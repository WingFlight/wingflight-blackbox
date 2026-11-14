<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/WingFlight/wingflight-landing-page/master/logos/wf_logo_dark_white.svg">
    <img src="https://raw.githubusercontent.com/WingFlight/wingflight-landing-page/master/logos/wf_logo_dark.svg" alt="Wingflight" width="420">
  </picture>
</p>

# Wingflight Blackbox Explorer

The Blackbox Explorer opens the flight logs a [Wingflight](https://github.com/WingFlight/wingflight-firmware)
flight controller records, and plots them: gyro against setpoint, servo and motor outputs, flight
modes, battery and anything else that was logged. Wingflight is open-source flight controller
firmware for fixed-wing aircraft.

**[Open in the browser](https://blackbox.wingflight.org)** ·
**[Desktop downloads](https://github.com/WingFlight/wingflight-blackbox/releases)** ·
**[Documentation](https://doc.wingflight.org)** ·
**[Discord](https://discord.gg/aEyyAJTXRw)**

![A flight log in the Blackbox Explorer](https://raw.githubusercontent.com/WingFlight/wingflight-docs/main/docs/assets/images/blackbox-viewer.png)


## Features

* Graphs of any logged field, with a legend showing the value under the cursor
* A 3D model of the aircraft's attitude and a stick overlay
* A spectrum analyser for finding vibration and tuning filters
* Step-response plots for judging a PID tune
* Flight video alongside the log, and export of the log drawn over the video
* Export to CSV
* Saved workspaces for the graph layouts you use most

Logging itself is set up in the Configurator's
[Blackbox tab](https://doc.wingflight.org/configurator/tabs/blackbox/).


## Installation

Use it in the browser at [blackbox.wingflight.org](https://blackbox.wingflight.org), or download the
desktop app from the [releases page](https://github.com/WingFlight/wingflight-blackbox/releases).
The desktop app needs Windows 10 or later, macOS or Linux.


## Usage

Click **Open** at the top right and select your log file, and your flight video if you recorded
one.

Scroll through the log by clicking or dragging on the seek bar under the main graph. The vertical
red bar in the center of the graph is the current time. You can also drag left and right on the
graph to scrub backwards and forwards.

### Customizing the graph display

Click **Graph setup** on the right to choose which fields are plotted. You may, for example, want
to remove the default gyro plot and add a plot for each rotation axis, or plot battery voltage
against throttle to see how your battery performs.

### Syncing your log to your flight video

The flight controller plays a short beep when arming, which is the start of the logged data. Sync
the log to the video by pressing "start log here" when you hear the beep in the video. Fine-tune
the alignment with the nudge left and nudge right buttons, or by editing the "log sync" value.
Positive values move the log toward the end of the video, negative values toward the beginning.

### Flight video won't load, or jumps in an exported video

Some video formats aren't supported by Chrome, so the viewer can't open them. Re-encode the video
with the free tool [Handbrake][]: choose MP4 as the format and H.264 as the video codec.

Because of [Google Bug #66631][], Chrome can't seek accurately in H.264 videos that use B-frames.
This is mostly fine when viewing, but in an exported video the flight video occasionally jumps
back a couple of frames. To avoid it, have Handbrake render every frame as an intraframe by adding
`keyint=1` to the Additional Options box.


## Development

See [HOWTO.md](HOWTO.md) for running from source and building, and
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.


## Contributing

Wingflight is a community project. You can help by:

* testing new versions and [reporting bugs](https://github.com/WingFlight/wingflight-blackbox/issues)
* helping other pilots on [Discord](https://discord.gg/aEyyAJTXRw)
* fixing bugs and adding features


## Origins

Wingflight is open source and free of charge, with no warranty.

The Blackbox Explorer is a fork of the [Rotorflight](https://github.com/rotorflight) Blackbox
Explorer, which is a fork of the [Betaflight](https://github.com/betaflight) Blackbox Explorer,
which is a fork of the [Cleanflight](https://github.com/cleanflight) one. Thank you to everyone who
contributed along the way.


[Handbrake]: https://handbrake.fr/
[Google Bug #66631]: http://code.google.com/p/chromium/issues/detail?id=66631
