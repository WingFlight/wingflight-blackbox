# 0.0.32

Decode the PROP_HANG debug mode (roll I relax, nose angle, vertical speed, hang timer, altitude estimate and rate flight).
Skip Step Response windows that don't measure the tune (not rotating, GYRO OFF, SETUP or a leveling mode, gyro past 2x the setpoint, surfaces at full travel), and show per-axis coherence, faded as low confidence below 0.5 or under 10 windows.
Grade Flight Analysis on real flight: stable flight counts only armed samples above 5% throttle, motor speed without a governor is compared at a steady throttle, and PID Tracking uses the step response, with an F suggestion when it is off.
Add a Bounce-Back lab (rebound after the stick is centred, per axis) and a GYRO OFF lab (how much of the commanded rate F alone gives).

Group development builds by pull request on the web landing page, and publish previews of pull requests labelled "preview".

# 0.0.30

Decode the 0.0.30 firmware's SNAP_RELAX debug mode (relax amount, snap active, stick spread, and roll, pitch and yaw stick).
Show Angle mode damping in the header dialog as a third LEVEL value.
Show PASSTHROUGH as SETUP and MANUAL as GYRO OFF.
Decode the removed HORIZON, PARALYZE, STICK COMMANDS DISABLE, ALTHOLD and CALIB modes as UNUSED, and drop the Horizon columns from the header view.

# 0.0.29

Read the per-axis I-term decay header (roll, pitch, yaw in 0.01 s, then max rate) from Wingflight API 22.7 logs; it showed a tenth of the real time and the pitch value as the max rate. Older single-value logs still read in 0.1 s. Decay now sits with relax in Iterm Settings.
Show the I-term relax level from API 22.8 logs, and hide the relax type there (relax is always on).
Name in-flight adjustment functions 114-125 (per-axis decay time and relax cutoff, main and TV loop), which showed as "Unknown (N)".
Name the Flight Feel values by their real names: Master Gain, I-term Decay and I-term Relax, including the adjustment functions. API 22.9 logs carry the 1-10 I-term Relax score in place of the relax cutoff in Hz; the header dialog shows whichever the log has.
Decode the 0.0.29 firmware's GAIN_ATTEN debug mode (TPA and SPA scales, filtered and raw GPS speed, GPS fix) and show its fw_spa header.
Add a Step Response view beside the Analyser that estimates roll, pitch and yaw tracking from ordinary flight logs (ported from Rotorflight).
Show 8 numbered harmonic lines, each with its frequency and rpm, in the frequency spectrum overlay.
Label unused firmware debug modes UNUSED_<slot>, matching the firmware.
Fix the example graphs for first-time users drawing blank.

# 0.0.28

Add wheel zoom around the mouse pointer (pinch on a trackpad), Shift+wheel or sideways swipe to scrub, and right-click menus on the graph and seek bar (go to time, set/clear start and end, markers, bookmarks, zoom, export video, save graph image).
Prompt for a save location when exporting video, CSV, workspaces and screenshots, falling back to a download where the browser can't.
Rebrand the welcome screen and navbar to match the WingFlight sites, with one Export menu in place of three buttons.
Say so when a CLI dump is opened instead of a log, rather than leaving "Trying to load file..." up.

# 0.0.27

Show separate roll and pitch deadbands in the log header dialog, following the 0.0.27 firmware header change.

# 0.0.26

Read the GPS navigation settings from the log header.
Publish release notes and a build link from the web deploy workflow.
Remove the push/PR CI workflows; only the deployed web build is kept.

# 0.0.25

Name and format the ATTHOLD/TVHOLD stall debug fields.

# 0.0.24

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.23

Add missing WingFlight in-flight adjustment function names (indices 82-114: master gain scaling, AutoHover/AttHold gain, servo trims, Thrust Vector PID/gain set, TV profile, flap compensation, diff thrust yaw), which previously showed as "Unknown (N)" on flight-mode-change graph annotations.
Add flightModeFlags2 and the missing WingFlight-specific flight mode/feature/state names (LOITER, RTH, THRUSTVECTOR, TVHOLD, TRADITIONAL, FEATURE_THRUST_VECTOR, GPS_FIX_EVER) to correctly decode current WingFlight logs.

# 0.0.22

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.21

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.20

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.19

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.18

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.17

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.16

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.15

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.14

Version bump for release alignment; no user-facing changes this cycle.

# 0.0.13

Version bump for release alignment; no user-facing changes this cycle.

# 0.0.12

Add idle chop recovery analysis.

# 0.0.11

Add web app deployment support for blackbox.wingflight.org and clean up browser compatibility.
Add flight-analysis tooling.
Fix WingFlight flight-mode/debug field definitions to align with current firmware.

# 0.0.10

Rename blackbox log fields headspeed/tailspeed to motor1speed/motor2speed, matching wingflight-firmware's generic per-motor naming.

# 0.0.9

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.8

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.7

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.6

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.5

Version bump for release alignment; no blackbox-relevant changes this cycle.

# 0.0.4

Remove collective references from Wingflight channel handling.
Clean up fixed-wing wording in I-term decay behavior.
Refresh release notes for the current Wingflight snapshot.

# 0.0.3

ESC Programing
Improve telemetry conditions
IdleUP governor

# 0.0.2

Align with firmware channel maps

# 0.0.1

Initial release

