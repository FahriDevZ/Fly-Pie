//////////////////////////////////////////////////////////////////////////////////////////
//        ___            _     ___                                                      //
//        |   |   \/    | ) |  |           This software may be modified and distri-    //
//    O-  |-  |   |  -  |   |  |-  -O      buted under the terms of the MIT license.    //
//        |   |_  |     |   |  |_          See the LICENSE file for details.            //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

'use strict';

const Cairo                                    = imports.cairo;
const {Gtk, Gdk, Pango, PangoCairo, GdkPixbuf} = imports.gi;

const _ = imports.gettext.domain('flypie').gettext;

const Me                 = imports.misc.extensionUtils.getCurrentExtension();
const utils              = Me.imports.src.common.utils;
const AchievementTracker = Me.imports.src.common.Achievements.AchievementTracker;
const AchievementState   = Me.imports.src.common.Achievements.AchievementState;

//////////////////////////////////////////////////////////////////////////////////////////
// The AchievementsPage class encapsulates code required for the 'Achievements' page of //
// the settings dialog. It's not instantiated multiple times, nor does it have any      //
// public interface, hence it could just be copy-pasted to the settings class. But as   //
// it's quite decoupled as well, it structures the code better when written to its own  //
// file.                                                                                //
//////////////////////////////////////////////////////////////////////////////////////////

var AchievementsPage = class AchievementsPage {

  // ------------------------------------------------------------ constructor / destructor

  constructor(builder, settings) {

    // Keep a reference to the builder and the settings.
    this._builder  = builder;
    this._settings = settings;

    // We keep several connections to the Gio.Settings object. Once the settings
    // dialog is closed, we use this array to disconnect all of them.
    this._settingsConnections = [];

    this._activeAchievements    = {};
    this._completedAchievements = {};

    this._achievementTracker = new AchievementTracker(this._settings);
    this._achievementTracker.connect('level-up', () => this._updateLevel());
    this._achievementTracker.connect(
        'experience-changed', () => this._updateExperience());
    this._achievementTracker.connect(
        'achievement-progress-changed',
        (o, id, cur, max) => this._updateProgress(id, cur, max));
    this._achievementTracker.connect(
        'achievement-unlocked', (o, id) => this._achievementUnlocked(id));
    this._achievementTracker.connect(
        'achievement-locked', (o, id) => this._achievementLocked(id));
    this._achievementTracker.connect(
        'achievement-completed', (o, id) => this._achievementCompleted(id));

    this._achievementTracker.getAchievements().forEach(
        (achievement, id) => this._add(achievement, id));

    this._reorderActiveAchievements();
    this._reorderCompletedAchievements();

    // Make the RadioButtons at the bottom behave like a StackSwitcher.
    const stack = this._builder.get_object('achievements-stack');
    this._builder.get_object('achievements-in-progress-button')
        .connect('toggled', button => {
          if (button.active) {
            stack.set_visible_child_name('page0');
          }
        });
    this._builder.get_object('achievements-completed-button')
        .connect('toggled', button => {
          if (button.active) {
            stack.set_visible_child_name('page1');

            // Hide the new-achievements counter when the second page is revealed.
            this._settings.set_uint('stats-unread-achievements', 0);
          }
        });

    this._builder.get_object('achievements-reset-button').connect('clicked', button => {
      // Create the question dialog.
      const dialog = new Gtk.MessageDialog({
        transient_for: button.get_toplevel(),
        modal: true,
        buttons: Gtk.ButtonsType.OK_CANCEL,
        message_type: Gtk.MessageType.QUESTION,
        text: _('Do you really want to reset all statistics?'),
        secondary_text: _('All achievements will be lost!')
      });

      // Reset all stats-* keys on a positive response.
      dialog.connect('response', (dialog, id) => {
        if (id == Gtk.ResponseType.OK) {
          this._settings.settings_schema.list_keys().forEach(key => {
            if (key.startsWith('stats-')) {
              this._settings.reset(key);
            }
          })
        }
        dialog.destroy();
      });

      dialog.show();
    });

    this._settingsConnections.push(this._settings.connect(
        'changed::stats-unread-achievements', () => this._updateCounter()));

    this._updateLevel();
    this._updateExperience();
    this._updateCounter();
  }

  // This should be called when the settings dialog is closed. It disconnects handlers
  // registered with the Gio.Settings object.
  destroy() {
    this._achievementTracker.destroy();

    this._settingsConnections.forEach(connection => {
      this._settings.disconnect(connection);
    });
  }

  // ----------------------------------------------------------------------- private stuff

  _updateLevel() {
    const level = this._achievementTracker.getCurrentLevel();
    this._builder.get_object('level-stack').set_visible_child_name('level' + level);
  }

  _updateExperience() {
    const cur = this._achievementTracker.getLevelXP()
    const max = this._achievementTracker.getLevelMaxXP();
    this._builder.get_object('experience-label').set_label(cur + ' / ' + max + ' XP');
    this._builder.get_object('experience-bar').set_max_value(max);
    this._builder.get_object('experience-bar').set_value(cur);
  }

  _updateProgress(id, cur, max) {
    this._activeAchievements[id].progressBar.set_value(cur);
    this._activeAchievements[id].progressLabel.set_label(cur + ' / ' + max);
    this._activeAchievements[id].progress = cur / max;

    this._reorderActiveAchievements();
  }

  _updateCounter() {
    const count  = this._settings.get_uint('stats-unread-achievements');
    const reveal = count != 0;
    this._builder.get_object('achievement-counter-revealer').reveal_child = reveal;

    if (reveal) {
      this._builder.get_object('achievement-counter').label = count.toString();
    }
  }

  _achievementUnlocked(id) {
    this._activeAchievements[id].revealer.reveal_child    = true;
    this._completedAchievements[id].revealer.reveal_child = false;

    this._reorderActiveAchievements();
  }

  _achievementLocked(id) {
    this._activeAchievements[id].revealer.reveal_child    = false;
    this._completedAchievements[id].revealer.reveal_child = false;
  }

  _achievementCompleted(id) {
    this._activeAchievements[id].revealer.reveal_child    = false;
    this._completedAchievements[id].revealer.reveal_child = true;

    const newDate                                   = new Date();
    this._completedAchievements[id].date            = newDate;
    this._completedAchievements[id].dateLabel.label = newDate.toLocaleString();

    this._reorderCompletedAchievements();
  }

  _reorderActiveAchievements() {
    const container = this._builder.get_object('active-achievements-box');
    const widgets   = Object.values(this._activeAchievements);
    widgets.sort((a, b) => b.progress - a.progress || a.name.localeCompare(b.name));

    for (let i = 0; i < widgets.length; i++) {
      container.reorder_child(widgets[i].revealer, i);
    }
  }

  _reorderCompletedAchievements() {
    const container = this._builder.get_object('completed-achievements-box');
    const widgets   = Object.values(this._completedAchievements);
    widgets.sort((a, b) => b.date - a.date || a.name.localeCompare(b.name));

    for (let i = 0; i < widgets.length; i++) {
      container.reorder_child(widgets[i].revealer, i);
    }
  }

  // Adds an achievement to the Gtk.FlowBox. This contains a composited image and a label
  // on-top.
  _add(achievement, id) {

    const active                 = this._createAchievementWidget(achievement, id, false);
    this._activeAchievements[id] = active;
    if (achievement.state == AchievementState.ACTIVE) {
      active.revealer.reveal_child = true;
    }

    const completed = this._createAchievementWidget(achievement, id, true);
    this._completedAchievements[id] = completed;
    if (achievement.state == AchievementState.COMPLETED) {
      completed.revealer.reveal_child = true;
    }

    this._builder.get_object('active-achievements-box')
        .pack_start(active.revealer, true, true, 0);
    this._builder.get_object('completed-achievements-box')
        .pack_start(completed.revealer, true, true, 0);
  }

  _createAchievementWidget(achievement, id, completed) {
    const result = {};

    const grid = new Gtk.Grid({margin_bottom: completed ? 0 : 8});

    const icon = new Gtk.DrawingArea({margin_right: 8});
    icon.set_size_request(64, 64);
    icon.connect('draw', (w, ctx) => {
      const background = GdkPixbuf.Pixbuf.new_from_file(
          Me.path + '/assets/badges/achievements/' + achievement.bgImage);
      const foreground = GdkPixbuf.Pixbuf.new_from_file(
          Me.path + '/assets/badges/achievements/' + achievement.fgImage);

      Gdk.cairo_set_source_pixbuf(ctx, background, 0, 0);
      ctx.paint();

      Gdk.cairo_set_source_pixbuf(ctx, foreground, 0, 0);
      ctx.paint();

      return false;
    });

    grid.attach(icon, 0, 0, 1, 3);

    result.name     = achievement.name;
    const nameLabel = new Gtk.Label({
      label: achievement.name,
      wrap: true,
      xalign: 0,
      max_width_chars: 0,
      hexpand: true,
      valign: Gtk.Align.END
    });
    nameLabel.get_style_context().add_class('title-4');
    grid.attach(nameLabel, 1, 0, 1, 1);

    const description = new Gtk.Label({
      label: achievement.description,
      wrap: true,
      xalign: 0,
      max_width_chars: 0,
      valign: Gtk.Align.START
    });
    grid.attach(description, 1, 1, 1, 1);

    const xp = new Gtk.Label({
      label: achievement.xp + ' XP',
      xalign: 1,
      valign: completed ? Gtk.Align.START : Gtk.Align.END
    });
    xp.get_style_context().add_class('dim-label');
    xp.get_style_context().add_class('caption');
    grid.attach(xp, 2, 1, 1, 1);

    if (completed) {

      result.date = new Date();
      let label   = '';

      if (achievement.state == AchievementState.COMPLETED) {
        const dates = this._settings.get_value('stats-achievement-dates').deep_unpack();
        if (dates.hasOwnProperty(id)) {
          result.date = new Date(dates[id]);
        }
        label = result.date.toLocaleString();
      }

      result.dateLabel = new Gtk.Label(
          {label: label, xalign: 1, width_request: 90, valign: Gtk.Align.END});
      result.dateLabel.get_style_context().add_class('dim-label');
      result.dateLabel.get_style_context().add_class('caption');
      grid.attach(result.dateLabel, 2, 0, 1, 1);

    } else {

      result.progress      = achievement.progress / achievement.range[1];
      result.progressLabel = new Gtk.Label({
        label: achievement.progress + ' / ' + achievement.range[1],
        xalign: 1,
        width_request: 90
      });
      result.progressLabel.get_style_context().add_class('dim-label');
      result.progressLabel.get_style_context().add_class('caption');
      grid.attach(result.progressLabel, 2, 2, 1, 1);

      result.progressBar = new Gtk.LevelBar({
        min_value: 0,
        max_value: achievement.range[1],
        value: achievement.progress,
        valign: Gtk.Align.CENTER
      });
      result.progressBar.remove_offset_value('low');
      result.progressBar.remove_offset_value('high');
      result.progressBar.remove_offset_value('full');
      result.progressBar.remove_offset_value('empty');
      grid.attach(result.progressBar, 1, 2, 1, 1);
    }

    result.revealer = new Gtk.Revealer();
    result.revealer.add(grid);
    result.revealer.show_all();

    return result;
  }
}