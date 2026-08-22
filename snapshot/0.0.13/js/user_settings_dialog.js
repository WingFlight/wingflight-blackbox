'use strict';

function UserSettingsDialog(dialog, onLoad, onSave) {

        // Private Variables

        // Setup Defaults....

        var defaultSettings = {
                stickMode                         : 2,                                // Default to Mode 2
                stickUnits                        : false,                        // Show units on stick display?
                stickTrails                        : false,                        // Show stick trails?
                stickInvertYaw                : false,                        // Invert yaw in stick display?
        legendUnits                        : true,                    // Show units on legend?
        seekbarPIDProfileColorBands        : false,                   // Show PID profile color bands on seekbar?
                gapless                                : false,
        drawCraft           : "3D",
        hasCraft            : true,
                drawPidTable                : true,
        drawSticks          : true,
                drawTime                        : true,
                drawEvents                        : true,
                drawAnalyser                : true,             // add an analyser option
                drawWatermark                : false,                        // Show Watermark on display?
                drawLapTimer                : false,                        // Show Laptimer on display?
                drawGradient                : false,                        // Show Gradient on display?
                drawVerticalBar                : true,                                // Show vertical timebar on display?
        graphSmoothOverride : true,             // Ability to toggle Smoothing off=normal/ on=force 0%
        graphExpoOverride   : true,             // Ability to toggle Expo off=normal/ on=force 100%
        graphGridOverride   : true,             // Ability to toggle Grid off=normal/ on=force disabled
                analyserSampleRate        : 2000/*Hz*/,                  // the loop time for the log
                analyserHanning            : true,                          // use a hanning window on the analyser sample data
                eraseBackground                : true,                   // Set to false if you want the graph to draw on top of an existing canvas image
                spectrumType        : 0,                // By default, frequency Spectrum
                overdrawSpectrumType: 0,                // By default, show all filters
                craft                                : {
                                                                        left  : '15%',        // position from left (as a percentage of width)
                                                                        top   : '25%',  // position from top (as a percentage of height)
                                                                        size  : '40%'   // size (as a percentage of width)
                                                          },
                sticks                                : {
                                                                        left  : '75%',        // position from left (as a percentage of width)
                                                                        top   : '20%',  // position from top (as a percentage of height)
                                                                        size  : '30%'   // size (as a percentage of width)
                                                          },
                analyser                        : {
                                                                        left  : '5%',        // position from left (as a percentage of width)
                                                                        top   : '60%',  // position from top (as a percentage of height)
                                                                        size  : '35%'   // size (as a percentage of width)
                                                          },
            watermark                        : {
                                                                        left  : '3%',        // position from left (as a percentage of width)
                                                                        top   : '90%',  // position from top (as a percentage of height)
                                                                        size  : '100%',  // size (as a percentage of width)
                                                                        transparency : '100%', //transparency of watermark image
                                                                        logo                 : null,   // No custom logo
                                                          },
            laptimer                        : {
                                                                        left  : '5%',                        // position from left (as a percentage of width)
                                                                        top   : '50%',                          // position from top (as a percentage of height)
                                                                        transparency : '40%',  // transparency of laptimer
                                                          },
        };

        var currentSettings = {};
        var currentLogo = null;

    function convertUIToSettings() {
            var settings = $.extend({}, currentSettings, {
                            sticks:    {top: $('.stick-mode-group input[name="stick-top"]').val() + '%',
                                               left: $('.stick-mode-group input[name="stick-left"]').val() + '%',
                                               size: $('.stick-mode-group input[name="stick-size"]').val() + '%', },
                            craft:     {top: $('.craft-settings input[name="craft-top"]').val() + '%',
                                               left: $('.craft-settings input[name="craft-left"]').val() + '%',
                                               size: $('.craft-settings input[name="craft-size"]').val() + '%', },
                            analyser:  {top: $('.analyser-settings input[name="analyser-top"]').val() + '%',
                                               left: $('.analyser-settings input[name="analyser-left"]').val() + '%',
                                               size: $('.analyser-settings input[name="analyser-size"]').val() + '%', },
                            watermark: {top: $('.watermark-settings input[name="watermark-top"]').val() + '%',
                                                      left: $('.watermark-settings input[name="watermark-left"]').val() + '%',
                                                      size: $('.watermark-settings input[name="watermark-size"]').val() + '%',
                                                      transparency: $('.watermark-settings input[name="watermark-transparency"]').val() + '%',
                                                      logo: currentLogo, },
                                drawWatermark: ($(".watermark").is(":checked")),
                            laptimer: {top: $('.laptimer-settings input[name="laptimer-top"]').val() + '%',
                                                      left: $('.laptimer-settings input[name="laptimer-left"]').val() + '%',
                                                      transparency: $('.laptimer-settings input[name="laptimer-transparency"]').val() + '%', },
                                drawLapTimer: ($(".laptimer").is(":checked")),
                                drawGradient: ($(".gradient").is(":checked")),
                                drawVerticalBar: ($(".verticalBar").is(":checked")),
            });
            return settings;
    }

    // Initialisation Code ...

        function stickModeSelection(val) {

                if(val==null) val=2; // default for invalid values

        currentSettings.stickMode = val;

                if(val>0 && val <= 5) {
                                $('.modePreview img').attr('src', './images/stick_modes/Mode_' + val + '.png');
                        }
        }

         // Buttons and Selectors

    $(".watermark").click(function() {
        if($(this).is(":checked")) {
            $(".watermark-group").show(300);
        } else {
            $(".watermark-group").hide(200);
        }
    });

    $(".laptimer").click(function() {
        if($(this).is(":checked")) {
            $(".laptimer-group").show(300);
        } else {
            $(".laptimer-group").hide(200);
        }
    });

    $(".user-settings-dialog-save").click(function(_e) {
            onSave(convertUIToSettings());
    });

    $('input[type=radio][name=stick-mode]').change(function() {
        stickModeSelection(parseInt($(this).val()));
    });

    $(".stick-units").click(function() {
            currentSettings.stickUnits = $(this).is(":checked");
    });

    $(".stick-trails").click(function() {
            currentSettings.stickTrails = $(this).is(":checked");
    });

        $(".invert-yaw").click(function() {
                currentSettings.stickInvertYaw = $(this).is(":checked");
        });

        $(".analyser-hanning").click(function() {
                currentSettings.analyserHanning = $(this).is(":checked");
        });

    $(".legend-units").click(function() {
        currentSettings.legendUnits = $(this).is(":checked");
    });

    $(".seekbar-pidprofile-color-bands").click(function() {
        currentSettings.seekbarPIDProfileColorBands = $(this).is(":checked");
    });

    // Load Custom Logo
    function readURL(input) {
        if (input.files && input.files[0]) {
            var reader = new FileReader();

            reader.onload = function (e) {
                $('#watermark-logo').attr('src', e.target.result);
                currentLogo = e.target.result;
            };

            reader.readAsDataURL(input.files[0]);
        }
    }

    $("#watermark-logo-load").change(function(){
        readURL(this);
    });

        // Initialise the userSettings

        onLoad(defaultSettings);

        // Public variables

        this.resetToDefaults = function() {
                currentSettings = $.extend({}, defaultSettings);
                onSave(currentSettings);
        };


    this.show = function(_flightLog, settings) {

                         currentSettings = $.extend({}, defaultSettings, currentSettings, settings || {});

                    if(currentSettings.stickUnits!=null) {
                            // set the toggle switch
                            $(".stick-units").prop('checked', currentSettings.stickUnits);
                    }

                    if(currentSettings.stickTrails!=null) {
                            // set the toggle switch
                            $(".stick-trails").prop('checked', currentSettings.stickTrails);
                    }

                        if(currentSettings.stickInvertYaw!=null) {
                                // set the toggle switch
                                $(".invert-yaw").prop('checked', currentSettings.stickInvertYaw);
                        }

                        if(currentSettings.analyserHanning!=null) {
                                // set the toggle switch
                                $(".analyser-hanning").prop('checked', currentSettings.analyserHanning);
                        }

                        if(currentSettings.legendUnits!=null) {
                                // set the toggle switch
                                $(".legend-units").prop('checked', currentSettings.legendUnits);
                        }

                        if(currentSettings.seekbarPIDProfileColorBands!=null) {
                                // set the toggle switch
                                $(".seekbar-pidprofile-color-bands").prop('checked', currentSettings.seekbarPIDProfileColorBands);
                        }


        stickModeSelection(currentSettings.stickMode);

                    // setup the stick mode dropdown;
                    $('input:radio[name="stick-mode"]').filter('[value="' + currentSettings.stickMode + '"]').attr('checked', true);

                    $('.stick-mode-group input[name="stick-top"]').val(parseInt(currentSettings.sticks.top));
                    $('.stick-mode-group input[name="stick-left"]').val(parseInt(currentSettings.sticks.left));
                    $('.stick-mode-group input[name="stick-size"]').val(parseInt(currentSettings.sticks.size));
                    $('.craft-settings input[name="craft-top"]').val(parseInt(currentSettings.craft.top));
                    $('.craft-settings input[name="craft-left"]').val(parseInt(currentSettings.craft.left));
                    $('.craft-settings input[name="craft-size"]').val(parseInt(currentSettings.craft.size));
                    $('.analyser-settings input[name="analyser-top"]').val(parseInt(currentSettings.analyser.top));
                    $('.analyser-settings input[name="analyser-left"]').val(parseInt(currentSettings.analyser.left));
                    $('.analyser-settings input[name="analyser-size"]').val(parseInt(currentSettings.analyser.size));

                    if(currentSettings.drawWatermark!=null) {
                            // set the toggle switch
                            $(".watermark").prop('checked', currentSettings.drawWatermark);
                            (currentSettings.drawWatermark)?$(".watermark-group").show(200):$(".watermark-group").hide(200);
                    }

                    $('.watermark-settings input[name="watermark-top"]').val(parseInt(currentSettings.watermark.top));
                    $('.watermark-settings input[name="watermark-left"]').val(parseInt(currentSettings.watermark.left));
                    $('.watermark-settings input[name="watermark-size"]').val(parseInt(currentSettings.watermark.size));
                    $('.watermark-settings input[name="watermark-transparency"]').val(parseInt(currentSettings.watermark.transparency));

                        if(currentSettings.watermark.logo!=null) {
                                currentLogo = currentSettings.watermark.logo;
                                $('#watermark-logo').attr('src', currentLogo);
                        } else {
                                currentLogo = $('#watermark-logo').attr('src');
                        }

                    if(currentSettings.drawLapTimer!=null) {
                            // set the toggle switch
                            $(".laptimer").prop('checked', currentSettings.drawLapTimer);
                            (currentSettings.drawLapTimer)?$(".laptimer-group").show(200):$(".laptimer-group").hide(200);
                    }

                    $('.laptimer-settings input[name="laptimer-top"]').val(parseInt(currentSettings.laptimer.top));
                    $('.laptimer-settings input[name="laptimer-left"]').val(parseInt(currentSettings.laptimer.left));
                    $('.laptimer-settings input[name="laptimer-transparency"]').val(parseInt(currentSettings.laptimer.transparency));

                        if (currentSettings.drawGradient != null) {
                                // set the toggle switch
                                $(".gradient").prop('checked', currentSettings.drawGradient);
                        }

                        if (currentSettings.drawVerticalBar != null) {
                                // set the toggle switch
                                $(".verticalBar").prop('checked', currentSettings.drawVerticalBar);
                        }

            dialog.modal('show');

    };

}
