//////////////////////////////////////////////////////////////////////////////////////////
//        ___            _     ___                                                      //
//        |   |   \/    | ) |  |           This software may be modified and distri-    //
//    O-  |-  |   |  -  |   |  |-  -O      buted under the terms of the MIT license.    //
//        |   |_  |     |   |  |_          See the LICENSE file for details.            //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

'use strict';

const {GLib, GObject, Gtk, Gio, Gdk, Pango} = imports.gi;

const _ = imports.gettext.domain('flypie').gettext;

const Me            = imports.misc.extensionUtils.getCurrentExtension();
const utils         = Me.imports.src.common.utils;
const AnimatedValue = Me.imports.src.prefs.AnimatedValue.AnimatedValue;

//////////////////////////////////////////////////////////////////////////////////////////
// This is the canvas where the editable menu is drawn to. It's a custom container      //
// widget and we use standard widgets such as GtkLabels and GtkButtons to draw the      //
// menu.                                                                                //
//////////////////////////////////////////////////////////////////////////////////////////

let FlyPieMenuEditorItem;

function registerWidget() {

  if (GObject.type_from_name('FlyPieMenuEditorItem') == null) {
    // clang-format off
    FlyPieMenuEditorItem = GObject.registerClass({
      GTypeName: 'FlyPieMenuEditorItem',
    },
    class FlyPieMenuEditorItem extends Gtk.ToggleButton {
          // clang-format on
          _init(params = {}) {
            super._init(params);

            this.margin_top    = 4;
            this.margin_start  = 4;
            this.margin_end    = 4;
            this.margin_bottom = 4;

            // this.add_css_class('pill-button');
            this.set_has_frame(false);

            this.x = new AnimatedValue();
            this.y = new AnimatedValue();

            // Create the Gio.Settings object.
            this._settings = utils.createSettings();

            const box   = Gtk.Box.new(Gtk.Orientation.VERTICAL, 2);
            box.vexpand = true;
            this.set_child(box);

            this._iconName = 'image-missing';

            this._icon = new Gtk.DrawingArea({hexpand: true, vexpand: true});
            this._icon.set_draw_func((widget, ctx) => {
              const size =
                  Math.min(widget.get_allocated_width(), widget.get_allocated_height());
              ctx.translate(
                  (widget.get_allocated_width() - size) / 2,
                  (widget.get_allocated_height() - size) / 2);
              const font  = this._settings.get_string('font');
              const color = widget.get_style_context().get_color();
              utils.paintIcon(ctx, this._config.icon, size, 1, font, color);
              return false;
            });
            box.append(this._icon);

            this._nameLabel = new Gtk.Label({ellipsize: Pango.EllipsizeMode.MIDDLE});
            this._nameLabel.add_css_class('caption-heading');
            box.append(this._nameLabel);

            this._shortcutLabel =
                new Gtk.Label({ellipsize: Pango.EllipsizeMode.MIDDLE, use_markup: true});
            this._shortcutLabel.add_css_class('dim-label');
            box.append(this._shortcutLabel);

            this._dragSource = new Gtk.DragSource();
            this._dragSource.connect('prepare', (s, x, y) => {
              s.set_icon(Gtk.WidgetPaintable.new(this._icon), x, y);
              return Gdk.ContentProvider.new_for_value('value');
            });
            this._dragSource.connect('drag-begin', () => {
              this.opacity = 0;
            });
            this._dragSource.connect('drag-end', () => {
              this.opacity = 1;
            });

            this.add_controller(this._dragSource);


            // For some reason, the drag source does not work anymore once the
            // ToggleButton was toggled. Resetting the EventController seems to be a
            // working workaround.
            this.connect('clicked', () => {
              this._dragSource.reset();
            });
          }

          setConfig(config) {
            this._config          = config;
            this._nameLabel.label = config.name;

            this._icon.queue_draw();

            if (config.shortcut) {
              const [ok, keyval, mods] = Gtk.accelerator_parse(config.shortcut);
              this._shortcutLabel.label =
                  '<small>' + Gtk.accelerator_get_label(keyval, mods) + '</small>';
            } else {
              this._shortcutLabel.label = '<small>' + _('Not Bound') + '</small>';
            }
          }
        })
  }

  if (GObject.type_from_name('FlyPieMenuEditor') == null) {
    // clang-format off
      GObject.registerClass({
        GTypeName: 'FlyPieMenuEditor',
        Signals: {
          'menu-select':  { param_types: [GObject.TYPE_INT]},
          'menu-edit':    { param_types: [GObject.TYPE_INT]},
          'menu-reorder': { param_types: [GObject.TYPE_INT, GObject.TYPE_INT]},
          'menu-delete':  { param_types: [GObject.TYPE_INT]},
          'menu-add':     { param_types: [Gdk.Rectangle.$gtype]},
        },
      },
      class FlyPieMenuEditor extends Gtk.Widget {
      // clang-format on
      _init(params = {}) {
        super._init(params);

        this._buttons         = [];
        this._selectedButton  = null;
        this._lastColumnCount = null;
        this._gridMode        = true;
        this._gridItemSize    = 128;
      }

      vfunc_get_request_mode() {
        return Gtk.SizeRequestMode.WIDTH_FOR_HEIGHT;
      }

      vfunc_measure(orientation, for_size) {
        if (this._gridMode) {
          if (orientation == Gtk.Orientation.HORIZONTAL) {
            return [this._gridItemSize * 4, this._gridItemSize * 4, -1, -1];
          }

          const columns = Math.floor(for_size / this._gridItemSize);
          const rows    = Math.ceil(this._buttons.length / columns);

          const gridSize = rows * this._gridItemSize;

          return [gridSize, gridSize, -1, -1];
        }

        return [300, 300, -1, -1];
      }

      _updateGrid(time) {
        for (let i = 0; i < this._buttons.length; i++) {
          const allocation = new Gdk.Rectangle({
            x: this._buttons[i].x.get(time),
            y: this._buttons[i].y.get(time),
            width: this._gridItemSize,
            height: this._gridItemSize
          });

          this._buttons[i].size_allocate(allocation, -1);
        }
      }

      vfunc_size_allocate(width, height, baseline) {

        if (this._buttons.length == 0) {
          return;
        }

        if (this._gridMode) {

          const columns     = Math.floor(width / this._gridItemSize);
          const rows        = Math.ceil(this._buttons.length / columns);
          const time        = GLib.get_monotonic_time() / 1000;
          const gridOffsetX = (width - columns * this._gridItemSize) / 2;
          const gridOffsetY = (height - rows * this._gridItemSize) / 2;


          let restartAnimation = false;

          const firstCall = this._lastColumnCount == undefined;

          if (columns != this._lastColumnCount) {
            this._lastColumnCount = columns;
            restartAnimation      = true;
          }

          for (let i = 0; i < this._buttons.length; i++) {

            const column = i % columns;
            const row    = Math.floor(i / columns);

            if (firstCall) {
              this._buttons[i].x.start = gridOffsetX + column * this._gridItemSize;
              this._buttons[i].y.start = gridOffsetY + row * this._gridItemSize;
            } else {
              this._buttons[i].x.start = this._buttons[i].x.get(time);
              this._buttons[i].y.start = this._buttons[i].y.get(time);
            }

            this._buttons[i].x.end = gridOffsetX + column * this._gridItemSize;
            this._buttons[i].y.end = gridOffsetY + row * this._gridItemSize;

            if (restartAnimation) {
              this._buttons[i].x.startTime = time;
              this._buttons[i].x.endTime   = time + 200;
              this._buttons[i].y.startTime = time;
              this._buttons[i].y.endTime   = time + 200;
            }
          }

          if (restartAnimation) {
            if (this._updateTimeout >= 0) {
              GLib.source_remove(this._updateTimeout);
              this._updateTimeout = -1;
            }

            this._updateTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
              const time = GLib.get_monotonic_time() / 1000;
              this._updateGrid(time);

              if (time >= this._buttons[0].x.endTime) {
                this._updateTimeout = -1;
                return false;
              }

              return true;
            });
          }

          this._updateGrid(time);

        } else {
        }
      }

      setConfigs(configs) {
        for (let i = 0; i < this._buttons.length; i++) {
          this._buttons[i].unparent();
        }

        this._buttons.length = 0;
        this._radioGroup     = null;

        for (let i = 0; i < configs.length; i++) {
          const button = new FlyPieMenuEditorItem();

          button.setConfig(configs[i]);
          button.set_parent(this);

          if (this._radioGroup) {
            button.set_group(this._radioGroup);
          } else {
            this._radioGroup = button;
          }

          button.connect('clicked', (b) => {
            if (b.active) {
              this._selectedButton = b;
              this.emit('menu-select', i);
            } else {
              this._selectedButton = null;
              this.emit('menu-select', -1);
            }
          });

          this._buttons.push(button);
        }

        const button = Gtk.Button.new_from_icon_name('list-add-symbolic');
        button.add_css_class('pill-button');
        button.set_has_frame(false);
        button.set_margin_start(24);
        button.set_margin_end(24);
        button.set_margin_top(24);
        button.set_margin_bottom(24);
        button.set_parent(this);

        button.x = new AnimatedValue();
        button.y = new AnimatedValue();

        this._buttons.push(button);

        button.connect('clicked', (b) => {
          this.emit('menu-add', b.get_allocation());
        });

        this.queue_allocate();
      }

      updateSelected(config) {
        if (this._selectedButton) {
          this._selectedButton.setConfig(config);
        }
      }
    });
  }
}