# WingFlight Blackbox

[WingFlight](https://github.com/WingFlight) is a Flight Control software suite designed for
fixed-wing aircraft. It consists of:

- WingFlight Flight Controller Firmware
- WingFlight Configurator, for flashing and configuring the flight controller
- WingFlight Blackbox Explorer, for analyzing blackbox flight logs (this repository)

WingFlight is forked from [Rotorflight](https://github.com/rotorflight), which was built on
Betaflight 4.3 and tailored for single-rotor helicopters. WingFlight repurposes that codebase for
fixed-wing aircraft -- helicopter-only systems such as the rotor speed governor, rescue modes, and
swashplate/cyclic mixing have been removed.


## Installation

Please download the latest version from [github](https://github.com/WingFlight/wingflight-blackbox/releases/).


## Features

WingFlight has many features:

* Many receiver protocols: CRSF, S.BUS, F.Port, DSM, IBUS, XBUS, EXBUS, GHOST, CPPM
* Support for various telemetry protocols: CSRF, S.Port, HoTT, etc.
* ESC telemetry protocols: BLHeli32, Hobbywing, Scorpion, Kontronik, OMP Hobby, ZTW, APD, YGE
* Advanced PID control tuned for fixed-wing aircraft
* Stabilisation modes (6D)
* Remote configuration and tuning with the transmitter
  - With knobs / switches assigned to functions
  - With LUA scripts on EdgeTX, OpenTX and Ethos
* Extra servo/motor outputs for AUX functions
* Fully customisable servo/motor mixer
* Sensors for battery voltage, current, BEC, etc.
* Advanced gyro filtering
  - Dynamic RPM based notch filters
  - Dynamic notch filters based on FFT
  - Dynamic LPF
* High-speed Blackbox logging

Plus lots of features inherited from Betaflight:

* Configuration profiles for changing various tuning parameters
* Rates profiles for changing the stick feel and agility
* Multiple ESC protocols: PWM, DSHOT, Multishot, etc.
* Configurable buzzer sounds
* Multi-color RGB LEDs
* GPS support

And many more...


## Notes

#### Windows

WingFlight Blackbox requires Windows 10 or later. Windows 7 is not supported.


## Usage

Click the "Open log file/video" button at the top right and select your log file and your flight video (if you recorded one).

You can scroll through the log by clicking or dragging on the seek bar that appears underneath the main graph. The
current time is represented by the vertical red bar in the center of the graph. You can also click and drag left and
right on the graph area to scrub backwards and forwards.

### Customizing the graph display

Click the "Graph Setup" button on the right side of the display in order to choose which fields should be plotted on
the graph. You may, for example, want to remove the default gyro plot and add separate gyro plots for each rotation axis.
Or you may want to plot vbat against throttle to examine your battery's performance.

### Syncing your log to your flight video

The blackbox plays a short beep on the buzzer when arming, and this corresponds with the start of the logged data.
You can sync your log against your flight video by pressing the "start log here" button when you hear the beep in the
video. You can tune the alignment of the log manually by pressing the nudge left and nudge right buttons in the log
sync section, or by editing the value in the "log sync" box. Positive values move the log toward the end of the video,
negative values move it towards the beginning.

### Flight video won't load, or jumpy flight video upon export

Some flight video formats aren't supported by Chrome, so the viewer can't open them. You can fix this by re-encoding
your video using the free tool [Handbrake][]. Open your original video using Handbrake. In the output settings, choose
MP4 as the format, and H.264 as the video codec.

Because of [Google Bug #66631][], Chrome is unable to accurately seek within H.264 videos that use B-frames. This is
mostly fine when viewing the flight video inside Blackbox Explorer. However, if you use the "export video" feature, this
bug will cause the flight video in the background of the exported video to occasionally jump backwards in time for a
couple of frames, causing a very glitchy appearance.

To fix that issue, you need to tell Handbrake to render every frame as an intraframe, which will avoid any problematic
B-frames. Do that by adding "keyint=1" into the Additional Options box.


## Contributing

WingFlight is an open-source community project. Anybody can join in and help to make it better by:

* [reporting](https://github.com/WingFlight/wingflight-blackbox/issues) bugs and issues, and suggesting improvements
* testing new software versions, new features and fixes; and providing feedback
* participating in discussions on new features
* contributing to the software development - fixing bugs, implementing new features and improvements


## Origins

WingFlight is software that is **open source** and is available free of charge without warranty.

WingFlight is forked from [Rotorflight](https://github.com/rotorflight), which is itself forked from
[Betaflight](https://github.com/betaflight), which in turn is forked from [Cleanflight](https://github.com/cleanflight).

Big thanks to everyone who has contributed along the journey!


## Contact

Questions and bug reports can be filed on the [GitHub issue tracker](https://github.com/WingFlight/wingflight-blackbox/issues).


[Handbrake]: https://handbrake.fr/
[Google Bug #66631]: http://code.google.com/p/chromium/issues/detail?id=66631
