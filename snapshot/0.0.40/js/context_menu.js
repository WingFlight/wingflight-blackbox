"use strict";

/**
 * A lightweight right-click menu.
 *
 * ContextMenu.show(items, pageX, pageY) where each item is one of:
 *     {header: "text"}
 *     {divider: true}
 *     {label: "text", shortcut: "I", action: function() {...}, disabled: false}
 *
 * The menu closes on selection, Escape, scrolling, resizing or clicking elsewhere.
 */
const ContextMenu = (function() {
    let menu = null;

    function close() {
        if (menu) {
            menu.remove();
            menu = null;
        }

        $(document).off(".wfContextMenu");
        $(window).off(".wfContextMenu");
    }

    function show(items, pageX, pageY) {
        close();

        menu = $('<ul class="dropdown-menu wf-context-menu" role="menu"></ul>');

        items.forEach(function(item) {
            if (item.divider) {
                menu.append('<li class="divider" role="separator"></li>');
            } else if (item.header) {
                menu.append($('<li class="dropdown-header"></li>').text(item.header));
            } else {
                let
                    li = $('<li role="presentation"></li>'),
                    a = $('<a href="#" role="menuitem"></a>');

                a.append($('<span class="wf-context-menu-label"></span>').text(item.label));

                if (item.shortcut) {
                    a.append($('<kbd class="wf-context-menu-shortcut"></kbd>').text(item.shortcut));
                }

                if (item.disabled) {
                    li.addClass("disabled");
                }

                a.on("click", function(e) {
                    e.preventDefault();

                    if (!item.disabled) {
                        close();
                        item.action();
                    }
                });

                menu.append(li.append(a));
            }
        });

        menu.css({display: "block", visibility: "hidden", left: 0, top: 0}).appendTo("body");

        // Keep the menu on screen, opening up/left from the cursor when it would overflow
        let
            width = menu.outerWidth(),
            height = menu.outerHeight(),
            viewLeft = $(window).scrollLeft(),
            viewTop = $(window).scrollTop(),
            left = pageX,
            top = pageY;

        if (left + width > viewLeft + $(window).width() - 4) {
            left = Math.max(viewLeft + 4, pageX - width);
        }
        if (top + height > viewTop + $(window).height() - 4) {
            top = Math.max(viewTop + 4, pageY - height);
        }

        menu.css({left: left, top: top, visibility: "visible"});

        // Defer so the click/contextmenu that opened the menu doesn't immediately close it
        setTimeout(function() {
            $(document).on("mousedown.wfContextMenu contextmenu.wfContextMenu", function(e) {
                if (!menu || !$.contains(menu[0], e.target)) {
                    close();
                }
            });
            $(document).on("keydown.wfContextMenu", function(e) {
                if (e.key === "Escape") {
                    close();
                }
            });
            $(window).on("resize.wfContextMenu blur.wfContextMenu wheel.wfContextMenu", close);
        }, 0);
    }

    return {
        show: show,
        close: close,
    };
})();
